import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { consumeOwnEcho, OWN_WRITE_GRACE_MS, recentlyWrittenHere, recordOwnWrite, writeConfig } from './config-store'

/**
 * `loadConfigStore` swallows a failed store call and falls back to defaults, and the browser dev
 * mock implements every store command, so a missing capability is invisible until a real build
 * runs — where it silently resets every setting on launch (#1424, shipped in 3.1.1 because
 * `store:allow-entries` was not granted). Assert the grant statically instead.
 */
describe('store capability', () => {
	const capabilities = JSON.parse(readFileSync(join(__dirname, '../../src-tauri/capabilities/main.json'), 'utf8'))
	const permissions: string[] = capabilities.permissions.filter((p: unknown) => typeof p === 'string')

	it('covers every store command the config layer uses', () => {
		// `load` and `entries` are the read path; without both, settings never come back.
		const required = ['load', 'entries', 'set', 'delete', 'get', 'has', 'clear', 'reset', 'save', 'get-store']
		const missing = required.filter((command) => !permissions.includes('store:default') && !permissions.includes(`store:allow-${command}`))
		expect(missing).toEqual([])
	})
})

/**
 * The store confirms each write with a change event over IPC, so while someone types "あい" the
 * confirmation of "あ" can land after the cache already holds "あい". Those echoes must not be
 * applied: they would put the field back a character and break an IME composition.
 */
describe('own-write echoes', () => {
	it('recognises the confirmation of a write and drops the stale ones before it', () => {
		recordOwnWrite('topic', 'あ')
		recordOwnWrite('topic', 'あい')
		recordOwnWrite('topic', 'あいう')
		// The echo of the middle write: it and the older one are ours, the newest is still pending.
		expect(consumeOwnEcho('topic', 'あい')).toBe(true)
		expect(consumeOwnEcho('topic', 'あ')).toBe(false)
		expect(consumeOwnEcho('topic', 'あいう')).toBe(true)
		// Nothing pending: a change is someone else's.
		expect(consumeOwnEcho('topic', 'あいう')).toBe(false)
	})

	it('treats an unknown value as an external change', () => {
		recordOwnWrite('other', 1)
		expect(consumeOwnEcho('other', 2)).toBe(false)
		expect(consumeOwnEcho('other', 1)).toBe(true)
	})

	it('records nothing while no store is loaded', () => {
		writeConfig('k', 'x')
		expect(consumeOwnEcho('k', 'x')).toBe(false)
	})
})

describe('file reloads while typing', () => {
	it('keeps a key this window wrote a moment ago, and lets go of it after the grace period', () => {
		recordOwnWrite('typing', 'ダークプロテ')
		expect(recentlyWrittenHere('typing')).toBe(true)
		expect(recentlyWrittenHere('typing', Date.now() + OWN_WRITE_GRACE_MS + 1)).toBe(false)
		expect(recentlyWrittenHere('never-written')).toBe(false)
	})
})
