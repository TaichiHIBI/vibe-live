import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/style'

/** `mm:ss` for the capture clock shown beside the meter. */
export function formatElapsed(seconds: number) {
	const minutes = Math.floor(seconds / 60)
	return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

// Live capture meter — five hairline bars driven by the backend's `record_level` event
// (a 0..1 peak, throttled to ~10/s). Center bars react hardest so the shape reads as a voice.
const BAR_WEIGHTS = [0.5, 0.78, 1, 0.78, 0.5]
const BAR_MIN_HEIGHT = 6
const BAR_MAX_HEIGHT = 18
/** Below this the capture counts as silence. */
const SILENCE_LEVEL = 0.03
/** How long silence must hold before the meter drops to dim stubs. */
const SILENCE_HOLD_MS = 1000
const METER_TICK_MS = 60
/** No event for this long means the stream stalled — let the target fall back to zero. */
const LEVEL_STALE_MS = 160

export function LevelMeter() {
	const [level, setLevel] = useState(0)
	const [silent, setSilent] = useState(false)
	// Refs keep the audio-rate values out of the render path; only the smoothed level is state.
	const targetRef = useRef(0)
	const lastEventRef = useRef(Date.now())
	const lastSoundRef = useRef(Date.now())

	useEffect(() => {
		const unlisten = listen<number>('record_level', ({ payload }) => {
			const next = typeof payload === 'number' && Number.isFinite(payload) ? Math.min(Math.max(payload, 0), 1) : 0
			targetRef.current = next
			lastEventRef.current = Date.now()
			if (next > SILENCE_LEVEL) lastSoundRef.current = Date.now()
		})

		const timer = window.setInterval(() => {
			const now = Date.now()
			// A dead device emits nothing at all — decay so it can't freeze mid-bar.
			if (now - lastEventRef.current > LEVEL_STALE_MS) targetRef.current *= 0.6
			// Fast attack, slower release: peaks stay legible, the fall stays calm.
			setLevel((prev) => {
				const target = targetRef.current
				const eased = prev + (target - prev) * (target > prev ? 0.7 : 0.3)
				return Math.abs(eased - target) < 0.004 ? target : eased
			})
			setSilent(now - lastSoundRef.current > SILENCE_HOLD_MS)
		}, METER_TICK_MS)

		return () => {
			window.clearInterval(timer)
			unlisten.then((fn) => fn())
		}
	}, [])

	return (
		<span aria-hidden className={cn('flex h-[18px] items-center gap-[3px]', silent && 'opacity-40')}>
			{BAR_WEIGHTS.map((weight, index) => (
				<span
					key={index}
					className="w-[2px] rounded-full bg-foreground transition-[height] duration-75 ease-out"
					style={{ height: silent ? BAR_MIN_HEIGHT : BAR_MIN_HEIGHT + level * weight * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) }}
				/>
			))}
		</span>
	)
}
