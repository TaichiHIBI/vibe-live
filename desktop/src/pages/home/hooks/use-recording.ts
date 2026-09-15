import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { type SetStateAction, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { m } from '~/paraglide/messages.js'
import type { AudioDevice } from '~/lib/audio'
import * as config from '~/lib/config'
import { CONFIG_KEYS } from '~/lib/config-keys'
import { usePersisted } from '~/lib/config-store'
import { combinePrompt, createClient, generateGlossary } from '~/lib/ai'
import { gpuOutOfMemoryBefore } from '~/lib/gpu-memory'
import { KEEP_AWAKE, startKeepAwake, stopKeepAwake } from '~/lib/keep-awake'
import { liveLanguage } from '~/lib/live-language'
import { listInstalledModels, type InstalledModel, type ModelMetadata } from '~/lib/model'
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

function errorMessage(error: unknown) {
	const object = typeof error === 'object' && error !== null ? (error as { message?: string }) : null
	return object?.message || String(error)
}

export function useRecording(onBeforeStart: () => void) {
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

	async function loadAudioDevices() {
		const newDevices = await invoke<AudioDevice[]>('get_audio_devices')
		const inputs = newDevices.filter((device) => device.isInput)
		const outputs = newDevices.filter((device) => !device.isInput)
		setInputDevice(
			savedInputDeviceId === null
				? (inputs.find((device) => device.isDefault) ?? null)
				: (inputs.find((device) => device.id === savedInputDeviceId) ?? null),
		)
		setOutputDevice(
			savedOutputDeviceId === null
				? (outputs.find((device) => device.isDefault) ?? null)
				: (outputs.find((device) => device.id === savedOutputDeviceId) ?? null),
		)
		setDevices(newDevices)
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

	function selectedDevices() {
		return [inputDevice, outputDevice].filter((device): device is AudioDevice => device !== null)
	}

	async function startRecord() {
		if (outputDevice && !(await ensureSystemAudioPermission())) return
		startKeepAwake(KEEP_AWAKE.record)
		onBeforeStart()
		setIsRecording(true)
		try {
			await invoke('start_record', {
				devices: selectedDevices(),
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
	 * Live mode: the model is loaded first, exactly as the transcribe queue does, then the capture
	 * streams to it. The session ends with `live_finish` or `live_error`, which the session handles.
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
		try {
			// The language was picked for the file model; a different live engine may spell it
			// differently (Whisper "ja", Nemotron "ja-JP"), so ask the live model what it takes.
			const metadata = modelPath === preference.modelPath ? preference.modelMetadata : await invoke<ModelMetadata>('get_model_metadata', { modelPath })
			const lang = liveLanguage(preference.modelOptions.lang, metadata?.capabilities)
			// The glossary comes first: the AI model and the speech model need not share memory.
			const prompt = await livePrompt(metadata)
			const loadResult = await invoke<string>('load_model', {
				modelPath,
				gpuDevice: preference.gpuDevice,
				noGpu: preference.noGpu || gpuOutOfMemoryBefore(modelPath),
				unloadTimeoutMinutes: preference.unloadTimeoutMinutes,
			})
			if (loadResult === 'gpu_fallback') toast.warning(m.gpuFallbackToCpu(), { position: 'bottom-center', duration: 8000 })
			const modelsFolder = await invoke<string>('get_models_folder')
			await invoke('start_live', {
				devices: selectedDevices(),
				options: {
					lang,
					vadModel: `${modelsFolder}/${config.vadModelFilename}`,
					recordingName: recordingName.trim() || null,
					prompt,
					...livePartialOptions(livePartialMode),
				},
			})
			setIsLive(true)
		} catch (error) {
			stopKeepAwake(KEEP_AWAKE.record)
			setIsLive(false)
			console.error('startLive error: ', error)
			setErrorModal?.({ log: errorMessage(error), open: true })
			// A session the backend did open but the window lost track of would hold the model
			// forever; ending it costs nothing when there is none.
			void invoke('stop_live').catch(() => undefined)
		} finally {
			setLiveStarting(false)
		}
	}

	/**
	 * Whisper's prompt for this live session: the AI-written vocabulary when asked for and the
	 * model reads prompts, else the one from the settings. A failed generation is a warning, not a
	 * reason to hold the session up.
	 */
	async function livePrompt(metadata: ModelMetadata | null | undefined): Promise<string | null> {
		if (metadata?.capabilities.text_prompts === false) return null
		const fallback = preference.modelOptions.init_prompt?.trim() || null
		if (!liveGlossary || !liveTopic.trim()) return fallback
		const pending = toast.loading(m.aiGlossaryGenerating(), { position: 'bottom-center' })
		try {
			const glossary = await generateGlossary(createClient(preference.ai.connection), {
				topic: liveTopic,
				transcript: '',
				language: preference.modelOptions.lang,
				contextTokens: preference.ai.connection.contextTokens,
			})
			toast.dismiss(pending)
			if (!glossary) return fallback
			toast.success(m.aiGlossaryReady(), { description: glossary, position: 'bottom-center', duration: 8000 })
			return combinePrompt(fallback, glossary)
		} catch (error) {
			toast.dismiss(pending)
			console.error('glossary generation failed', error)
			toast.warning(m.aiGlossaryFailed(), { description: errorMessage(error), position: 'bottom-center' })
			return fallback
		}
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
