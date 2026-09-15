import { Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { m } from '~/paraglide/messages.js'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import type { Job } from '../hooks/use-transcribe-queue'
import { useSession } from '../session'
import { formatElapsed, LevelMeter } from './level-meter'

/** Seconds since the capture started, ticking like the record panel's clock. */
function useElapsed(startedAt: number | undefined) {
	const [elapsed, setElapsed] = useState(0)
	useEffect(() => {
		if (!startedAt) {
			setElapsed(0)
			return
		}
		const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
		tick()
		const timer = window.setInterval(tick, 500)
		return () => window.clearInterval(timer)
	}, [startedAt])
	return elapsed
}

/**
 * The live session's controls, above the transcript it streams into: meter, clock, whether the
 * transcriber has joined, and Stop. Stopping is asynchronous — the backend flushes the open
 * utterance, then `live_finish` turns the job into a finished project and this banner goes away.
 */
export default function LiveBanner({ job }: { job: Job }) {
	const { recording } = useSession()
	const [stopping, setStopping] = useState(false)
	const elapsed = useElapsed(job.startedAt)

	// A new session in the same job slot starts from a fresh button.
	useEffect(() => setStopping(false), [job.id])

	function stop() {
		setStopping(true)
		void recording.stopLive()
	}

	return (
		<div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-border bg-muted/50 px-3 py-2 text-[12px]">
			<LevelMeter />
			<span className="font-mono text-sm tracking-tight tabular-nums text-foreground">{formatElapsed(elapsed)}</span>
			<span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
				{job.liveReady ? (
					<>
						<span aria-hidden className="relative flex h-2 w-2 shrink-0">
							<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/60" />
							<span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
						</span>
						<span className="truncate font-medium text-foreground">{m.liveLabel()}</span>
					</>
				) : (
					<>
						<Spinner className="h-3 w-3 shrink-0" />
						<span className="truncate">{m.livePreparing()}</span>
					</>
				)}
			</span>
			<Button size="sm" onClick={stop} disabled={stopping} className="rounded-full">
				{stopping ? <Spinner className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5 fill-current" />}
				{stopping ? m.liveFinishing() : m.stopLive()}
			</Button>
		</div>
	)
}
