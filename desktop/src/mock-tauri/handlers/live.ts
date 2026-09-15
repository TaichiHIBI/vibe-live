// Mock handlers for live transcription (see docs/LIVE.md, "Tauri commands and events").
// Fakes the capture meter plus the server's partial/segment lines on timers, so the live view
// can be exercised in the browser without a device or a model.
import { emitMockEvent } from '../event-bus'
import { APP_LOCAL_DATA, virtualFs } from '../state'
import type { CommandHandlerMap } from '../types'

interface Segment {
	start: number
	stop: number
	text: string
}

const LEVEL_TICK_MS = 100
/** One word of the open utterance lands per tick, like the server's partial cadence. */
const PARTIAL_TICK_MS = 350
/** Pause between two utterances, so the meter's silence state is seen too. */
const UTTERANCE_GAP_MS = 1200
const FINISH_DELAY_MS = 400
const CENTISECONDS_PER_MS = 0.1

const SCRIPT = [
	'Welcome to the live transcription mock.',
	'Every line arrives first as a partial, one word at a time.',
	'When the voice activity detector closes the utterance it becomes a final segment.',
	'Stopping flushes the open line and saves the session as a project.',
	'The mock keeps looping through these sentences until you press stop.',
]

interface LiveSession {
	startedAt: number
	segments: Segment[]
	recordingName: string | null
	levelTimer: number
	lineTimer: number
}

let session: LiveSession | null = null

/**
 * Fake speech envelope during an utterance, near-silence between them, so the meter tracks the
 * words on screen instead of a metronome.
 */
function levelFor(speaking: boolean, tick: number) {
	if (!speaking) return 0.01 + Math.random() * 0.015
	const syllables = 0.5 + 0.5 * Math.sin(tick * 0.55)
	const jitter = Math.random() * 0.18
	return Math.min(0.9, Math.max(0.08, syllables * 0.75 + jitter))
}

function elapsedCentiseconds(startedAt: number) {
	return Math.round((Date.now() - startedAt) * CENTISECONDS_PER_MS)
}

function clearTimers(current: LiveSession) {
	window.clearInterval(current.levelTimer)
	window.clearTimeout(current.lineTimer)
}

/** Feed the script: grow a partial word by word, close it as a segment, pause, next sentence. */
function scheduleLines(current: LiveSession) {
	let sentence = 0
	let words = 0
	let utteranceStart = elapsedCentiseconds(current.startedAt)
	let speaking = true
	let tick = 0

	current.levelTimer = window.setInterval(() => {
		tick += 1
		emitMockEvent('record_level', levelFor(speaking, tick))
	}, LEVEL_TICK_MS)

	function step() {
		if (session !== current) return
		const text = SCRIPT[sentence % SCRIPT.length]
		const allWords = text.split(' ')
		words += 1
		const now = elapsedCentiseconds(current.startedAt)
		if (words < allWords.length) {
			emitMockEvent('live_partial', { start: utteranceStart, stop: now, text: allWords.slice(0, words).join(' ') })
			current.lineTimer = window.setTimeout(step, PARTIAL_TICK_MS)
			return
		}
		const segment: Segment = { start: utteranceStart, stop: now, text }
		current.segments.push(segment)
		emitMockEvent('live_segment', segment)
		speaking = false
		sentence += 1
		words = 0
		current.lineTimer = window.setTimeout(() => {
			if (session !== current) return
			speaking = true
			utteranceStart = elapsedCentiseconds(current.startedAt)
			step()
		}, UTTERANCE_GAP_MS)
	}

	current.lineTimer = window.setTimeout(step, PARTIAL_TICK_MS)
}

export const liveHandlers: CommandHandlerMap = {
	// ({ devices, recordingName }) — the capture; lines only start with `live_connect`.
	start_live: (args) => {
		console.info('[mock] start_live', args)
		if (session) throw { code: 'busy', message: 'a live session is already open' }
		const current: LiveSession = {
			startedAt: Date.now(),
			segments: [],
			recordingName: typeof args.recordingName === 'string' && args.recordingName ? args.recordingName : null,
			levelTimer: 0,
			lineTimer: 0,
		}
		session = current
		return undefined
	},

	// ({ options: { lang, vadModel, prompt, partialMode, partialIntervalMs } }) — the transcriber joins.
	live_connect: (args) => {
		console.info('[mock] live_connect', args)
		const current = session
		if (!current) throw { code: 'invalid_request', message: 'no live capture is waiting' }
		window.setTimeout(() => {
			if (session !== current) return
			emitMockEvent('live_ready', null)
			scheduleLines(current)
		}, 800)
		return undefined
	},

	// Returns immediately; the result is the `live_finish` event, as with the real command.
	stop_live: () => {
		const current = session
		if (!current) throw { code: 'invalid_request', message: 'no live session is open' }
		session = null
		clearTimers(current)
		const name = `${current.recordingName ?? 'live'}.wav`
		const path = `${APP_LOCAL_DATA}/${name}`
		window.setTimeout(() => {
			virtualFs.set(path, null)
			emitMockEvent('live_finish', { path, name, segments: current.segments })
		}, FINISH_DELAY_MS)
		return undefined
	},
}
