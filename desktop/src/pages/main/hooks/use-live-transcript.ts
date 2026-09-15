import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useState } from 'react'
import type { Segment } from '~/lib/transcript'

export interface LiveTranscript {
	/** Lines the VAD closed, oldest first. */
	segments: Segment[]
	/** The utterance in progress; replaced on every `live_partial`, cleared by the next `live_segment`. */
	partial: Segment | null
	/** Seconds since the session started. */
	elapsed: number
	reset: () => void
}

/**
 * The transcript of the live session as it arrives from the backend (see docs/LIVE.md). Only the
 * lines are kept here; the session owns starting, stopping and turning the result into a project.
 */
export function useLiveTranscript(active: boolean): LiveTranscript {
	const [segments, setSegments] = useState<Segment[]>([])
	const [partial, setPartial] = useState<Segment | null>(null)
	const [elapsed, setElapsed] = useState(0)

	const reset = useCallback(() => {
		setSegments([])
		setPartial(null)
	}, [])

	useEffect(() => {
		const unlisteners: Promise<UnlistenFn>[] = [
			listen<Segment>('live_partial', ({ payload }) => setPartial(payload)),
			listen<Segment>('live_segment', ({ payload }) => {
				setSegments((previous) => [...previous, payload])
				setPartial(null)
			}),
		]
		return () => {
			unlisteners.forEach((promise) => promise.then((unlisten) => unlisten()))
		}
	}, [])

	// Same clock the recording panel shows, so the two modes read alike.
	useEffect(() => {
		setElapsed(0)
		if (!active) return
		const startedAt = Date.now()
		const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500)
		return () => window.clearInterval(timer)
	}, [active])

	return { segments, partial, elapsed, reset }
}
