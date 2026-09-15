import type { ModelCapabilities } from '~/lib/model'

/**
 * The file model's language setting, in the live model's spelling. Whisper lists "ja", Nemotron
 * "ja-JP"; either way the base code matches. Anything the live model cannot name falls back to
 * auto-detection when it has it, else goes through unchanged so the engine reports it.
 */
export function liveLanguage(lang: string, capabilities: Pick<ModelCapabilities, 'languages' | 'language_detection'> | null | undefined) {
	if (!capabilities || lang === 'auto' || capabilities.languages.includes(lang)) return lang
	const base = lang.split('-')[0].toLowerCase()
	const match =
		capabilities.languages.find((code) => code.toLowerCase() === base) ?? capabilities.languages.find((code) => code.toLowerCase().startsWith(`${base}-`))
	if (match) return match
	return capabilities.language_detection ? 'auto' : lang
}
