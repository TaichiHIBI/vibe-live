import { listen } from '@tauri-apps/api/event'
import { load, type Store } from '@tauri-apps/plugin-store'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import * as config from '~/lib/config'

/**
 * Settings live in `app_config.json` next to the app's other data, not in `localStorage`: the file
 * survives a cleared webview, every window sees the same values, and a person (or an agent) can
 * open it and edit it.
 *
 * Reads have to be synchronous for React, so the whole file is pulled into a cache once at boot and
 * kept fresh by the store's change events — which also cover writes from another window.
 */
/**
 * Emitted by the Rust file watcher after someone edited `app_config.json` outside the app. The
 * store's own reload is silent (it only emits on set/delete/clear), so this carries the whole file.
 */
const CONFIG_CHANGED_EVENT = 'config-changed'

let store: Store | null = null
const cache = new Map<string, unknown>()
const listeners = new Map<string, Set<() => void>>()

/**
 * Values this window wrote that the store has not echoed back yet. The plugin confirms every
 * `set` with a change event, over IPC, so while someone types "あい" the confirmation of "あ" can
 * land after the cache already holds "あい" — and applying it would put the field back a
 * character, which also breaks an IME composition in progress. Echoes are matched off and dropped.
 */
const ownWrites = new Map<string, unknown[]>()
const OWN_WRITES_CAP = 64

/** Exported for the unit test; the store path calls it from `writeConfig`. */
export function recordOwnWrite(key: string, value: unknown) {
	lastOwnWriteAt.set(key, Date.now())
	const queue = ownWrites.get(key) ?? []
	queue.push(value)
	if (queue.length > OWN_WRITES_CAP) queue.shift()
	ownWrites.set(key, queue)
}

/**
 * When each key was last written from this window. The store's autosave lands on disk ~300 ms
 * after a write, and the Rust file watcher compares that file with the plugin's memory — which
 * by then can already hold the next keystroke. That looks like an external edit, the plugin
 * reloads the older file, and the field is rolled back mid-word (an IME composition dies with it).
 * A key written this recently keeps this window's value, and the value is written down again so
 * the file catches up.
 */
const lastOwnWriteAt = new Map<string, number>()
export const OWN_WRITE_GRACE_MS = 3_000

/** True when this window wrote `key` within the grace period; such keys ignore file reloads. */
export function recentlyWrittenHere(key: string, now = Date.now()) {
	return now - (lastOwnWriteAt.get(key) ?? 0) < OWN_WRITE_GRACE_MS
}

/** True when a change event is the store confirming this window's own write; consumes the entry. */
export function consumeOwnEcho(key: string, value: unknown) {
	const queue = ownWrites.get(key)
	if (!queue || queue.length === 0) return false
	const index = queue.findIndex((written) => JSON.stringify(written) === JSON.stringify(value))
	if (index < 0) return false
	// Everything before it was superseded before its echo arrived; those echoes are stale too.
	queue.splice(0, index + 1)
	if (queue.length === 0) ownWrites.delete(key)
	return true
}

function notify(key: string) {
	for (const listener of listeners.get(key) ?? []) listener()
}

/** Must finish before the first render, or every setting would flash its default. */
export async function loadConfigStore() {
	try {
		// autoSave batches the disk writes: a slider being dragged costs one save, not fifty.
		store = await load(config.storeFilename, { autoSave: 300, defaults: {} })
		for (const [key, value] of await store.entries()) cache.set(key, value)
		await store.onChange((key, value) => {
			if (consumeOwnEcho(key, value)) return
			if (value === undefined) cache.delete(key)
			else cache.set(key, value)
			notify(key)
		})
		await listen<Record<string, unknown>>(CONFIG_CHANGED_EVENT, ({ payload }) => applyExternalConfig(payload))
	} catch (error) {
		// A broken or unreadable file must not stop the app: every setting falls back to its default.
		console.error('failed to load the config store:', error)
	}
}

/** Replace the cache with a config file edited from outside, waking only the keys that moved. */
function applyExternalConfig(next: Record<string, unknown> | null) {
	const incoming = next ?? {}
	const keys = new Set([...cache.keys(), ...Object.keys(incoming)])
	for (const key of keys) {
		const before = cache.get(key)
		const after = incoming[key]
		if (JSON.stringify(before) === JSON.stringify(after)) continue
		if (recentlyWrittenHere(key)) {
			// Our own save racing the typing, not an edit from outside: keep what is on screen and
			// put it back into the store, which the reload just reset to the older file.
			if (cache.has(key)) {
				recordOwnWrite(key, before)
				void store?.set(key, before)
			} else {
				recordOwnWrite(key, undefined)
				void store?.delete(key)
			}
			continue
		}
		if (key in incoming) cache.set(key, after)
		else cache.delete(key)
		notify(key)
	}
}

export function readConfig<T>(key: string, fallback: T): T {
	return cache.has(key) ? (cache.get(key) as T) : fallback
}

export function writeConfig<T>(key: string, value: T) {
	cache.set(key, value)
	notify(key)
	// Fire and forget, like the old localStorage write: the screen must not wait on the disk.
	if (store) recordOwnWrite(key, value)
	void store?.set(key, value)
}

/** Remove a setting from both the live cache and the persisted config file. */
export function deleteConfig(key: string) {
	cache.delete(key)
	notify(key)
	if (store) recordOwnWrite(key, undefined)
	void store?.delete(key)
}

function subscribe(key: string, listener: () => void) {
	const existing = listeners.get(key) ?? new Set<() => void>()
	existing.add(listener)
	listeners.set(key, existing)
	return () => {
		existing.delete(listener)
		if (existing.size === 0) listeners.delete(key)
	}
}

/**
 * Drop-in replacement for `useLocalStorage`: same tuple, same functional-update setter, but the
 * value is stored in the config file and shared across windows.
 */
export function usePersisted<T>(key: string, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
	// Callers pass object literals as defaults; pinning the first one keeps the snapshot identity
	// stable while the key is missing, which useSyncExternalStore requires.
	const fallback = useRef(initial)

	const value = useSyncExternalStore(
		useCallback((listener: () => void) => subscribe(key, listener), [key]),
		useCallback(() => readConfig(key, fallback.current), [key]),
	)

	const setValue = useCallback(
		(next: T | ((previous: T) => T)) => {
			const resolved = typeof next === 'function' ? (next as (previous: T) => T)(readConfig(key, fallback.current)) : next
			writeConfig(key, resolved)
		},
		[key],
	)

	return [value, setValue]
}
