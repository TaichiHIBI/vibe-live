import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { type SetStateAction, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { m } from '~/paraglide/messages.js'
import type { AudioDevice } from '~/lib/audio'
import * as config from '~/lib/config'
import { CONFIG_KEYS } from '~/lib/config-keys'
import { usePersisted } from '~/lib/config-store'
import { combinePrompt, normalizeGlossary } from '~/lib/ai'
import { gpuOutOfMemoryBefore } from '~/lib/gpu-memory'
import { KEEP_AWAKE, startKeepAwake, stopKeepAwake } from '~/lib/keep-awake'
import { liveLanguage } from '~/lib/live-language'
import { isModelFileUsable, listInstalledModels, type InstalledModel, type ModelMetadata } from '~/lib/model'
import { ensureSystemAudioPermission } from '~/lib/permissions'
import { ErrorModalContext } from '~/providers/error-modal'
import { usePreferenceProvider } from '~/providers/preference'

/** 'off', 'auto', or a fixed interval in milliseconds (as a string, for the select). */
export type LivePartialMode = 'off' | 'auto' | '500' | '1000' | '2000' | '3000' | '5000'
export const LIVE_PARTIAL_FIXED_MS = [500, 1000, 2000, 3000, 5000] as const

/** The `start_live` option fields for a partial mode. */
export function livePartialOptions(mode: LivePartialMode) {
	if (mode === 'off' || mode === 'auto') return { partialMode: mode }
	return { partialMode: 'fixed', partialIntervalMs: Number(mode) }
}

/**
 * Live segments speech with Silero VAD whatever the engine, but the VAD file is only fetched for
 * engines that require it or for stable timestamps, so a Whisper-only install has none. It is
 * under 1 MB: fetch it here rather than fail the session.
 */
async function ensureLiveVad(modelsFolder: string) {
	const vadPath = `${modelsFolder}/${config.vadModelFilename}`
	if (await isModelFileUsable(vadPath)) return vadPath
	const pending = toast.loading(m.downloadingVadModel(), { position: 'bottom-center' })
	try {
		await invoke('download_model', { url: config.vadModelUrl, path: vadPath })
	} finally {
		toast.dismiss(pending)
	}
	return vadPath
}

function errorMessage(error: unknown) {
	const object = typeof error === 'object' && error !== null ? (error as { message?: string }) : null
	return object?.message || String(error)
}

export interface RecordingHooks {
	/** The live capture is running: called with the provisional project name, before `isLive` flips. */
	onLiveStarted?: (provisionalName: string) => void
	/** `start_live` itself failed, so no capture and no session exist. */
	onLiveStartFailed?: (message: string) => void
}

export function useRecording(onBeforeStart: () => void, hooks?: RecordingHooks) {
	const preference = usePreferenceProvider()
	const { setState: setErrorModal } = useContext(ErrorModalContext)
	const [devices, setDevices] = useState<AudioDevice[]>([])
	const [savedInputDeviceId, setSavedInputDeviceId] = usePersisted<string | null>(CONFIG_KEYS.inputDeviceId, null)
	const [savedOutputDeviceId, setSavedOutputDeviceId] = usePersisted<string | null>(CONFIG_KEYS.outputDeviceId, null)
	const [liveEnabled, setLiveEnabled] = usePersisted<boolean>(CONFIG_KEYS.liveTranscriptionEnabled, false)
	/** Live can run a lighter model than the file workflow; empty means the same one. */
	const [liveModelPath, setLiveModelPath] = usePersisted<string>(CONFIG_KEYS.liveModelPath, '')
	const [installedModels, setInstalledModels] = useState<InstalledModel[]>([])
	/** How often the live view's line in progress is re-decoded; the GPU load knob. */
	const [livePartialMode, setLivePartialMode] = usePersisted<LivePartialMode>(CONFIG_KEYS.livePartialMode, 'auto')
	/** Vocabulary prompt for Whisper live, written by the AI connection from the topic. */
	const [liveGlossary, setLiveGlossary] = usePersisted<boolean>(CONFIG_KEYS.liveGlossary, false)
	const [liveTopic, setLiveTopic] = usePersisted<string>(CONFIG_KEYS.liveTopic, '')
	const [liveVocabulary, setLiveVocabulary] = usePersisted<string>(CONFIG_KEYS.liveVocabulary, '')
	const [liveModelMetadata, setLiveModelMetadata] = useState<ModelMetadata | null>(null)
	const [inputDevice, setInputDevice] = useState<AudioDevice | null>(null)
	const [outputDevice, setOutputDevice] = useState<AudioDevice | null>(null)
	const [isRecording, setIsRecording] = useState(false)
	/** A live session is open: capturing and transcribing at once. Cleared by `live_finish` / `live_error`. */
	const [isLive, setIsLive] = useState(false)
	/** Between the click and the session opening (the glossary alone can take half a minute). */
	const [liveStarting, setLiveStarting] = useState(false)
	const [recordingName, setRecordingName] = useState('')

	function setInputDeviceAndSave(value: SetStateAction<AudioDevice | null>) {
		const device = typeof value === 'function' ? value(inputDevice) : value
		setSavedInputDeviceId(device?.id ?? '')
		setInputDevice(device)
	}

	function setOutputDeviceAndSave(value: SetStateAction<AudioDevice | null>) {
		const device = typeof value === 'function' ? value(outputDevice) : value
		setSavedOutputDeviceId(device?.id ?? '')
		setOutputDevice(device)
	}

	/**
	 * Enumerate the devices afresh and re-resolve the two choices against them. Ids are device
	 * names, so a choice survives replugging; one that is gone (or a stale index from older
	 * versions) falls back to the default of its kind rather than to "none".
	 */
	async function loadAudioDevices() {
		const newDevices = await invoke<AudioDevice[]>('get_audio_devices')
		const inputs = newDevices.filter((device) => device.isInput)
		const outputs = newDevices.filter((device) => !device.isInput)
		const pick = (list: AudioDevice[], saved: string | null) => {
			if (saved === '') return null
			return (saved !== null ? list.find((device) => device.id === saved) : undefined) ?? list.find((device) => device.isDefault) ?? null
		}
		const input = pick(inputs, savedInputDeviceId)
		const output = pick(outputs, savedOutputDeviceId)
		setInputDevice(input)
		setOutputDevice(output)
		setDevices(newDevices)
		return { input, output }
	}

	useEffect(() => {
		if (preference.homeTab !== 'record') return
		loadAudioDevices()
		listInstalledModels()
			.then((models) => setInstalledModels(models.filter((model) => model.valid)))
			.catch((error) => console.error('listing models for live mode failed', error))
	}, [preference.homeTab])

	/** The model live mode runs: the chosen one while it still exists on disk, else the file model. */
	const liveModel = (liveModelPath && installedModels.some((model) => model.path === liveModelPath) ? liveModelPath : null) ?? preference.modelPath

	// What the live model can do decides which live options show (a prompt means nothing to Nemotron).
	useEffect(() => {
		if (!liveModel) {
			setLiveModelMetadata(null)
			return
		}
		if (liveModel === preference.modelPath) {
			setLiveModelMetadata(preference.modelMetadata ?? null)
			return
		}
		let cancelled = false
		invoke<ModelMetadata>('get_model_metadata', { modelPath: liveModel })
			.then((metadata) => {
				if (!cancelled) setLiveModelMetadata(metadata)
			})
			.catch((error) => {
				console.error('reading the live model metadata failed', error)
				if (!cancelled) setLiveModelMetadata(null)
			})
		return () => {
			cancelled = true
		}
	}, [liveModel, preference.modelPath, preference.modelMetadata])
	const livePromptable = liveModelMetadata?.capabilities.text_prompts !== false

	/** The devices to open, enumerated now: what was plugged in since the panel opened counts. */
	async function selectedDevices() {
		const { input, output } = await loadAudioDevices()
		return [input, output].filter((device): device is AudioDevice => device !== null)
	}

	async function startRecord() {
		if (outputDevice && !(await ensureSystemAudioPermission())) return
		startKeepAwake(KEEP_AWAKE.record)
		onBeforeStart()
		setIsRecording(true)
		try {
			await invoke('start_record', {
				devices: await selectedDevices(),
				recordingName: recordingName.trim() || null,
			})
		} catch (error) {
			stopKeepAwake(KEEP_AWAKE.record)
			setIsRecording(false)
			console.error('startRecord error: ', error)
			setErrorModal?.({ log: String(error), open: true })
		}
	}

	async function stopRecord() {
		try {
			await emit('stop_record')
		} catch (error) {
			stopKeepAwake(KEEP_AWAKE.record)
			setIsRecording(false)
			console.error('stopRecord error: ', error)
			setErrorModal?.({ log: String(error), open: true })
		}
	}

	/**
	 * Live mode: the capture starts the moment the button is pressed; the model, the vocabulary
	 * prompt and the socket are prepared while it already records, and the audio from in between is
	 * sent once the session connects. It ends with `live_finish` or `live_error`, which the session
	 * handles.
	 */
	async function startLive() {
		if (liveStarting || isLive) return
		const modelPath = liveModel
		if (!modelPath) {
			toast.error(m.noModelSelected(), { position: 'bottom-center' })
			return
		}
		if (outputDevice && !(await ensureSystemAudioPermission())) return
		setLiveStarting(true)
		startKeepAwake(KEEP_AWAKE.record)
		onBeforeStart()
		let capturing = false
		try {
			await invoke('start_live', { devices: await selectedDevices(), recordingName: recordingName.trim() || null })
			capturing = true
			hooks?.onLiveStarted?.(recordingName.trim() || 'Live')
			setIsLive(true)
			// The language was picked for the file model; a different live engine may spell it
			// differently (Whisper "ja", Nemotron "ja-JP"), so ask the live model what it takes.
			const metadata = modelPath === preference.modelPath ? preference.modelMetadata : await invoke<ModelMetadata>('get_model_metadata', { modelPath })
			const lang = liveLanguage(preference.modelOptions.lang, metadata?.capabilities)
			const prompt = livePrompt(metadata)
			const loadResult = await invoke<string>('load_model', {
				modelPath,
				gpuDevice: preference.gpuDevice,
				noGpu: preference.noGpu || gpuOutOfMemoryBefore(modelPath),
				unloadTimeoutMinutes: preference.unloadTimeoutMinutes,
			})
			if (loadResult === 'gpu_fallback') toast.warning(m.gpuFallbackToCpu(), { position: 'bottom-center', duration: 8000 })
			const modelsFolder = await invoke<string>('get_models_folder')
			const vadModel = await ensureLiveVad(modelsFolder)
			await invoke('live_connect', {
				options: {
					lang,
					vadModel,
					prompt,
					...livePartialOptions(livePartialMode),
				},
			})
		} catch (error) {
			console.error('startLive error: ', error)
			setErrorModal?.({ log: errorMessage(error), open: true })
			if (capturing) {
				// The capture is running without a transcriber: end it as a plain recording, which
				// arrives as `live_finish` with the audio and no lines.
				void invoke('stop_live').catch(() => undefined)
			} else {
				stopKeepAwake(KEEP_AWAKE.record)
				setIsLive(false)
				hooks?.onLiveStartFailed?.(errorMessage(error))
				// A session the backend did open but the window lost track of would hold the model
				// forever; ending it costs nothing when there is none.
				void invoke('stop_live').catch(() => undefined)
			}
		} finally {
			setLiveStarting(false)
		}
	}

	/**
	 * Whisper's prompt for this live session: the one from the settings, then the word list when it
	 * is switched on and the model reads prompts. The list is written before the start, by hand or
	 * with AI, so starting never waits on an AI connection.
	 */
	function livePrompt(metadata: ModelMetadata | null | undefined): string | null {
		if (metadata?.capabilities.text_prompts === false) return null
		const fallback = preference.modelOptions.init_prompt?.trim() || null
		if (!liveGlossary) return fallback
		return combinePrompt(fallback, normalizeGlossary(liveVocabulary))
	}

	/** Returns at once; `isLive` stays set until the backend's `live_finish` (or `live_error`) lands. */
	async function stopLive() {
		try {
			await invoke('stop_live')
		} catch (error) {
			stopKeepAwake(KEEP_AWAKE.record)
			setIsLive(false)
			console.error('stopLive error: ', error)
			setErrorModal?.({ log: errorMessage(error), open: true })
		}
	}

	return {
		devices,
		setDevices,
		reloadDevices: () => void loadAudioDevices(),
		inputDevice,
		outputDevice,
		isRecording,
		setIsRecording,
		isLive,
		setIsLive,
		liveStarting,
		liveEnabled,
		setLiveEnabled,
		liveModelPath,
		setLiveModelPath,
		liveModel,
		installedModels,
		livePartialMode,
		setLivePartialMode,
		liveGlossary,
		setLiveGlossary,
		liveTopic,
		setLiveTopic,
		liveVocabulary,
		setLiveVocabulary,
		livePromptable,
		recordingName,
		setRecordingName,
		setInputDevice: setInputDeviceAndSave,
		setOutputDevice: setOutputDeviceAndSave,
		startRecord,
		stopRecord,
		startLive,
		stopLive,
	}
}
