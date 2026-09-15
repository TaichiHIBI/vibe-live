import { AnimatePresence, motion } from 'framer-motion'
import { AudioLines, FolderOpen, Link2, Mic, Plus, Square, Upload, X } from 'lucide-react'
import { siFacebook, siInstagram, siTiktok, siX, siYoutube } from 'simple-icons'
import { useEffect } from 'react'
import { m } from '~/paraglide/messages.js'
import AudioDeviceInput from '~/components/audio-device-input'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { NativeSelect } from '~/components/ui/native-select'
import { Spinner } from '~/components/ui/spinner'
import { Switch } from '~/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { getFriendlyModelName } from '~/lib/model'
import { cn } from '~/lib/style'
import { parseMediaLinks } from '~/lib/ytdlp'
import { LIVE_PARTIAL_FIXED_MS, type LivePartialMode } from '~/pages/home/hooks/use-recording'
import { useSession, type IdlePanel } from '../session'
import { formatElapsed, LevelMeter } from './level-meter'
import QuietRow from './quiet-row'

/** One segment of the joined source switcher: icon-only keys, the active one reads as raised. */
function Segment({ active, label, onClick, children }: { active?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-pressed={active}
					aria-label={label}
					onClick={onClick}
					className={cn(
						'inline-flex h-10 w-14 cursor-pointer items-center justify-center rounded-full transition-colors duration-150',
						active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
					)}>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	)
}

function RecordPanel() {
	const { recording, recordElapsed, preference } = useSession()

	useEffect(() => {
		// The recording hook loads audio devices for this tab only.
		preference.setHomeTab('record')
	}, [])

	if (recording.isRecording) {
		return (
			<div className="flex flex-col items-center gap-4 py-2.5">
				<div className="flex items-center gap-3">
					<LevelMeter />
					<span className="font-mono text-2xl tracking-tight tabular-nums">{formatElapsed(recordElapsed)}</span>
				</div>
				<Button onClick={() => recording.stopRecord()} className="h-10 w-full rounded-xl">
					<Square className="h-3.5 w-3.5 fill-current" />
					{m.stopRecording()}
				</Button>
			</div>
		)
	}

	return (
		// Device labels become eyebrows and the triggers drop to h-10 so the panel stays a compact
		// tool row instead of a form. Restyled from here to keep AudioDeviceInput's API untouched.
		<div
			className={cn(
				'flex w-full flex-col gap-5 py-2.5',
				'[&_label]:text-[11px] [&_label]:font-medium [&_label]:tracking-[0.08em] [&_label]:text-muted-foreground [&_label]:uppercase',
			)}>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>div]:space-y-1.5 [&_button]:h-10 [&_button]:rounded-xl">
				<AudioDeviceInput type="input" devices={recording.devices} device={recording.inputDevice} setDevice={recording.setInputDevice} />
				<AudioDeviceInput type="output" devices={recording.devices} device={recording.outputDevice} setDevice={recording.setOutputDevice} />
			</div>
			{/* Live: transcribe while capturing instead of recording first. A span, not a label, so the */}
			{/* eyebrow styling above stays with the device pickers. */}
			<div className="-my-1.5 flex items-center justify-between gap-3">
				<span id="live-transcription-label" className="text-[13px] text-foreground/90">
					{m.liveTranscription()}
				</span>
				<Switch
					aria-labelledby="live-transcription-label"
					checked={recording.liveEnabled}
					onCheckedChange={(checked) => recording.setLiveEnabled(checked)}
				/>
			</div>
			{/* Live can run a lighter engine than the file workflow (Nemotron beside a large Whisper). */}
			{recording.liveEnabled && (
				<div className="space-y-1.5">
					<label htmlFor="live-model">{m.liveModel()}</label>
					<NativeSelect
						id="live-model"
						className="h-10 rounded-xl"
						value={recording.installedModels.some((model) => model.path === recording.liveModelPath) ? recording.liveModelPath : ''}
						onChange={(event) => recording.setLiveModelPath(event.target.value)}>
						<option value="">{m.liveModelSameAsFile()}</option>
						{recording.installedModels.map((model) => (
							<option key={model.path} value={model.path}>
								{preference.modelDisplayNames[model.path] ?? getFriendlyModelName(model.name)}
							</option>
						))}
					</NativeSelect>
					{/* Every refresh re-runs the encoder over the open utterance: this is the GPU knob. */}
					<label htmlFor="live-partial-mode" className="pt-2">
						{m.livePartialMode()}
					</label>
					<NativeSelect
						id="live-partial-mode"
						className="h-10 rounded-xl"
						value={recording.livePartialMode}
						onChange={(event) => recording.setLivePartialMode(event.target.value as LivePartialMode)}>
						<option value="auto">{m.livePartialAuto()}</option>
						<option value="off">{m.livePartialOff()}</option>
						{LIVE_PARTIAL_FIXED_MS.map((ms) => (
							<option key={ms} value={String(ms)}>
								{m.livePartialEvery({ seconds: String(ms / 1000) })}
							</option>
						))}
					</NativeSelect>
					{/* Whisper reads a prompt; the AI turns the topic into one. Nemotron has no such input. */}
					{recording.livePromptable && (
						<>
							<div className="flex items-center justify-between gap-3 pt-3">
								<span id="live-glossary-label" className="text-[13px] text-foreground/90">
									{m.aiGlossary()}
								</span>
								<Switch aria-labelledby="live-glossary-label" checked={recording.liveGlossary} onCheckedChange={recording.setLiveGlossary} />
							</div>
							{recording.liveGlossary && (
								<Input
									value={recording.liveTopic}
									onChange={(event) => recording.setLiveTopic(event.target.value)}
									placeholder={m.aiGlossaryTopicPlaceholder()}
									aria-label={m.aiGlossaryTopic()}
									className="h-10 rounded-xl"
								/>
							)}
						</>
					)}
				</div>
			)}
			<Button
				onClick={() => (recording.liveEnabled ? recording.startLive() : recording.startRecord())}
				disabled={
					recording.liveStarting ||
					!(recording.liveEnabled ? recording.liveModel : preference.modelPath) ||
					(!recording.inputDevice && !recording.outputDevice)
				}
				className="h-10 w-full rounded-xl disabled:opacity-40">
				{recording.liveStarting ? (
					<Spinner className="h-4 w-4" />
				) : recording.liveEnabled ? (
					<AudioLines className="h-4 w-4" />
				) : (
					<Mic className="h-4 w-4" />
				)}
				{recording.liveStarting ? m.liveStarting() : recording.liveEnabled ? m.startLive() : m.startRecord()}
			</Button>
		</div>
	)
}

// Bundled monochrome brand marks of the most-used yt-dlp sources — fills the panel with a
// "works with" row instead of dead space. Rendered tiny and muted so it stays quiet.
const linkSources: { title: string; path: string }[] = [
	{ title: siYoutube.title, path: siYoutube.path },
	{ title: siTiktok.title, path: siTiktok.path },
	{ title: siInstagram.title, path: siInstagram.path },
	{ title: siX.title, path: siX.path },
	{ title: siFacebook.title, path: siFacebook.path },
]

function LinkPanel() {
	const { link, preference } = useSession()

	if (link.downloadingAudio) {
		const percent = link.ytdlpProgress ?? 0
		// yt-dlp reports nothing until the stream starts; show motion rather than a stuck 0%.
		const started = percent > 0
		return (
			<div className="flex w-full flex-col items-center gap-4 py-2.5">
				<span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-background/70 text-foreground shadow-sm">
					<span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-foreground/5" />
					<Link2 className="h-5 w-5" />
				</span>

				<div className="w-full max-w-sm space-y-2">
					<div className="flex items-baseline justify-between gap-3">
						<span className="truncate text-[13px] font-medium text-foreground">{m.downloading({ progress: String(percent) })}</span>
						<span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">{started ? `${percent}%` : '—'}</span>
					</div>

					<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
						{started ? (
							<div className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
						) : (
							// Indeterminate: a short bar sweeping the track while we wait for the first byte.
							<div className="download-sweep h-full w-1/3 rounded-full bg-foreground/70" />
						)}
					</div>

					{link.batch && (
						<p dir="ltr" className="truncate text-center text-[12px] text-muted-foreground/80">
							{link.batch.total > 1 && (
								<span className="me-2 font-medium text-muted-foreground">
									{m.linkOfTotal({ current: String(link.batch.index + 1), total: String(link.batch.total) })}
								</span>
							)}
							{link.batch.url}
						</p>
					)}
				</div>

				<Button
					variant="ghost"
					size="sm"
					onClick={() => link.cancelYtDlpDownload()}
					className="h-8 rounded-full px-4 text-[13px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
					{m.cancel()}
				</Button>
			</div>
		)
	}

	return (
		<motion.div layout className="flex w-full flex-col items-center gap-5 py-2.5">
			<motion.div layout="position" className="flex w-full items-center gap-3">
				<div className="relative min-w-0 flex-1">
					<Input
						type="text"
						value={link.audioUrl}
						onChange={(event) => link.setAudioUrl(event.target.value)}
						onKeyDown={(event) => (event.key === 'Enter' ? void link.downloadAudio() : null)}
						// Several links pasted together go straight into the list; one stays in the box.
						onPaste={(event) => {
							const pasted = event.clipboardData.getData('text')
							if (parseMediaLinks(pasted).length < 2) return
							event.preventDefault()
							link.queueLinks(`${link.audioUrl} ${pasted}`)
						}}
						// Short enough to stay fully readable when the window is narrow.
						placeholder={link.queuedLinks.length ? m.pasteAnotherLink() : m.pasteMediaLink()}
						className={cn('h-10 min-w-0 rounded-xl px-3.5 text-sm', link.audioUrl && 'pe-10')}
					/>
					{/* The way to build a list by hand: park this link and type the next one. */}
					{link.audioUrl && (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={m.addLink()}
									onClick={() => link.queueLinks()}
									className="absolute end-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/80">
									<Plus className="h-4 w-4" />
								</button>
							</TooltipTrigger>
							<TooltipContent>{m.addLink()}</TooltipContent>
						</Tooltip>
					)}
				</div>
				<Button
					onClick={() => link.downloadAudio()}
					disabled={!preference.modelPath || link.pendingLinks.length === 0}
					// Wide enough for the count, so the box beside it never changes size.
					className="h-10 w-32 shrink-0 rounded-xl px-4 disabled:opacity-40">
					{m.transcribe()}
					{link.pendingLinks.length > 1 && (
						<span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px] font-semibold tabular-nums">{link.pendingLinks.length}</span>
					)}
				</Button>
			</motion.div>

			{/* Links waiting their turn, each removable until the run starts. The list keeps the */}
			{/* card's width and scrolls vertically once it holds more than a few, so nothing else */}
			{/* moves; rows slide in and out, and the card's own re-centring is animated with them. */}
			<AnimatePresence initial={false}>
				{link.queuedLinks.length > 0 && (
					<motion.ul key="queued-links" layout className="flex max-h-28 w-full flex-col gap-1 overflow-y-auto overscroll-contain">
						<AnimatePresence initial={false}>
							{link.queuedLinks.map((url) => (
								<motion.li
									key={url}
									layout
									initial={{ height: 0, opacity: 0 }}
									animate={{ height: 'auto', opacity: 1 }}
									exit={{ height: 0, opacity: 0 }}
									transition={{ duration: 0.18, ease: 'easeOut' }}
									className="group shrink-0 overflow-hidden rounded-lg text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted/60">
									<div className="flex items-center gap-2.5 px-2 py-1">
										<Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
										<span dir="ltr" className="min-w-0 flex-1 truncate text-start text-foreground/90">
											{url}
										</span>
										<button
											type="button"
											aria-label={m.removeLink()}
											onClick={() => link.removeQueuedLink(url)}
											className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/80">
											<X className="h-3.5 w-3.5" />
										</button>
									</div>
								</motion.li>
							))}
						</AnimatePresence>
					</motion.ul>
				)}
			</AnimatePresence>

			<motion.div layout="position" className="flex flex-col items-center gap-3">
				<p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/80 uppercase">{m.worksWith()}</p>
				<div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 text-muted-foreground/70">
					{linkSources.map((source) => (
						<Tooltip key={source.title}>
							<TooltipTrigger asChild>
								<svg
									viewBox="0 0 24 24"
									aria-label={source.title}
									role="img"
									className="h-[18px] w-[18px] transition-colors duration-150 hover:text-foreground">
									<path d={source.path} fill="currentColor" />
								</svg>
							</TooltipTrigger>
							<TooltipContent side="bottom">{source.title}</TooltipContent>
						</Tooltip>
					))}
					<span className="text-[12px] text-muted-foreground/70">{m.moreSources()}</span>
				</div>
			</motion.div>
		</motion.div>
	)
}

export default function IdleHero() {
	const { dragging, browse, collectingFolder, panel, setPanel, link, recording } = useSession()

	function selectPanel(next: IdlePanel) {
		if (recording.isRecording || recording.isLive || next === panel) return
		setPanel(next)
		if (next === 'link') void link.switchToLinkTab()
	}

	return (
		// One optical column: pills, active source and quiet row all span max-w-xl with a 20px rhythm.
		// The extra bottom padding lifts the column above the true centre — optically centred reads better.
		<div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 pt-4 pb-[30vh]">
			{/* Joined source switcher: one control, three keys; the active source replaces the drop area. */}
			<div className="mx-auto inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 p-1">
				<Segment active={panel === 'none'} label={m.fromFile()} onClick={() => selectPanel('none')}>
					<FolderOpen className="h-[18px] w-[18px]" />
				</Segment>
				<Segment active={panel === 'record'} label={m.record()} onClick={() => selectPanel('record')}>
					<Mic className="h-[18px] w-[18px]" />
				</Segment>
				<Segment active={panel === 'link'} label={m.fromLink()} onClick={() => selectPanel('link')}>
					<Link2 className="h-[18px] w-[18px]" />
				</Segment>
			</div>

			{/* Fixed-height slot sized to the drop zone so switching sources never moves the pills or the quiet row. */}
			<div className="flex min-h-[220px] w-full flex-col justify-center">
				<AnimatePresence mode="wait" initial={false}>
					{panel === 'none' ? (
						<motion.button
							key="drop"
							type="button"
							onClick={() => void browse()}
							initial={{ opacity: 0, y: 6 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -6 }}
							transition={{ duration: 0.18, ease: 'easeOut' }}
							className={cn(
								'group relative cursor-pointer overflow-hidden rounded-[1.25rem] border-2 border-dashed transition-colors duration-150',
								dragging ? 'border-foreground/40' : 'border-border bg-muted/30 hover:border-foreground/25 hover:bg-muted/50',
							)}>
							{/* The aurora is drag feedback only — at rest the zone stays a quiet surface. */}
							<div
								className={cn(
									'aurora pointer-events-none absolute inset-0 transition-opacity duration-200',
									dragging ? 'opacity-100' : 'opacity-0',
								)}
							/>

							<div className="relative flex flex-col items-center gap-3.5 px-8 py-12 text-center">
								<span className="flex h-12 w-12 items-center justify-center rounded-full bg-background/70 text-foreground shadow-sm">
									{collectingFolder ? <Spinner className="h-5 w-5" /> : <Upload className="h-5 w-5" />}
								</span>
								<div className="space-y-1">
									<h1 className="text-xl font-semibold tracking-[-0.02em] text-foreground">{m.dropFilesHere()}</h1>
									<p className="text-[13px] text-muted-foreground">{m.orClickToBrowse()}</p>
								</div>
							</div>
						</motion.button>
					) : (
						<motion.div
							key={panel}
							initial={{ opacity: 0, y: 6 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -6 }}
							transition={{ duration: 0.18, ease: 'easeOut' }}
							// Same footprint as the drop zone so the composition stays anchored.
							className="flex min-h-[220px] w-full flex-col justify-center rounded-[1.25rem] border border-border bg-muted/30 px-7">
							{panel === 'record' ? <RecordPanel /> : <LinkPanel />}
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			<QuietRow />
		</div>
	)
}
