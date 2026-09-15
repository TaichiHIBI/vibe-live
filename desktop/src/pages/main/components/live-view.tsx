import { motion } from 'framer-motion'
import { Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { m } from '~/paraglide/messages.js'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { cn } from '~/lib/style'
import { formatTimestamp, type Segment } from '~/lib/transcript'
import { useSession } from '../session'
import { formatElapsed, LevelMeter } from './level-meter'

/** How close to the tail counts as still following, in pixels — same feel as the transcript view. */
const BOTTOM_STICK_PX = 96

function LiveLine({ segment, partial }: { segment: Segment; partial?: boolean }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: 4 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.15, ease: 'easeOut' }}
			className="-mx-3 flex gap-3 rounded-xl px-3 py-2">
			<span className="mt-[3px] flex h-5 w-[52px] shrink-0 items-center justify-end font-mono text-[11px] tracking-tight tabular-nums text-muted-foreground select-none">
				{partial ? (
					// The line still being spoken has no settled time yet; the dot says it is moving.
					<span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
				) : (
					formatTimestamp(segment.start, false, '', false)
				)}
			</span>
			<span className={cn('block min-w-0 flex-1 whitespace-pre-wrap', partial ? 'text-muted-foreground italic' : 'text-foreground')}>
				{segment.text.trim()}
			</span>
		</motion.div>
	)
}

/**
 * The live session: meter, clock and Stop up top, the closed lines and the one in progress below.
 * Stopping is asynchronous — the backend flushes the open utterance, then `live_finish` lands and
 * the session leaves this mode, which unmounts the view.
 */
export default function LiveView() {
	const { recording, live, preference } = useSession()
	const scrollRef = useRef<HTMLDivElement>(null)
	const followingRef = useRef(true)
	const [stopping, setStopping] = useState(false)

	// Scrolling away releases the follow; landing back at the tail re-arms it, like a log view.
	const onScroll = useCallback(() => {
		const element = scrollRef.current
		if (!element) return
		followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_STICK_PX
	}, [])

	useEffect(() => {
		const element = scrollRef.current
		if (!element || !followingRef.current) return
		element.scrollTop = element.scrollHeight
	}, [live.segments.length, live.partial?.text])

	function stop() {
		setStopping(true)
		void recording.stopLive()
	}

	const empty = live.segments.length === 0 && !live.partial

	return (
		<motion.div
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: 'easeOut' }}
			className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-4 border-b border-border px-6 py-3">
				<div className="flex items-center gap-3">
					<LevelMeter />
					<span className="font-mono text-2xl tracking-tight tabular-nums">{formatElapsed(live.elapsed)}</span>
				</div>
				<div className="flex-1" />
				<Button onClick={stop} disabled={stopping} className="h-10 min-w-32 rounded-xl">
					{stopping ? <Spinner className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5 fill-current" />}
					{stopping ? m.liveFinishing() : m.stopLive()}
				</Button>
			</div>

			<div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
				<div dir={preference.textAreaDirection} className="mx-auto w-full max-w-[86ch] px-8 py-10 xl:max-w-[96ch]">
					{empty ? (
						<p className="text-sm text-muted-foreground">{m.transcriptWillDisplayedShortly()}</p>
					) : (
						<div className="flex flex-col gap-1">
							{live.segments.map((segment, index) => (
								<LiveLine key={`${segment.start}-${index}`} segment={segment} />
							))}
							{live.partial && <LiveLine key="partial" segment={live.partial} partial />}
						</div>
					)}
				</div>
			</div>
		</motion.div>
	)
}
