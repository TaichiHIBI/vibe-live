import type { AiClient } from './client'
import { inputBudgetBytes, utf8Bytes } from './client'

/** Whisper reads only the tail of its prompt (~220 tokens), so the list is kept short. */
export const GLOSSARY_MAX_CHARS = 400

const GLOSSARY_TEMPLATE = `You prepare a vocabulary hint for a speech-recognition model (the "initial prompt" of Whisper).
Topic of the recording: {topic}
Language of the recording: {language}

Below is a rough automatic transcript of the same recording. It may contain misheard words, especially homophones spelled with the wrong characters.
List the technical terms, proper nouns and jargon that are likely to be spoken in this recording, each written CORRECTLY in the recording's language. Fix any misheard homophones from context. Prefer terms that a general speech model would get wrong. Terms and acronyms that are normally written in the Latin alphabet even in that language (product names, model names, abbreviations such as SVM or ViT) stay in the Latin alphabet with their usual spelling. Do not repeat a term.
Output one line: the terms separated by commas, at most 40 terms, no numbering, no explanations, nothing else.

Transcript:
{transcript}`

export interface GlossaryInput {
	topic: string
	/** The existing transcript, one line per segment; may be empty. */
	transcript: string
	/** Human-readable language name or code of the recording. */
	language: string
	contextTokens: number
}

export function buildGlossaryPrompt({ topic, transcript, language, contextTokens }: GlossaryInput) {
	const frame = GLOSSARY_TEMPLATE.replace('{topic}', topic.trim() || '(unknown)').replace('{language}', language)
	// The head of the transcript is what fits; a glossary does not need all of it.
	const budget = Math.max(0, inputBudgetBytes(contextTokens) - utf8Bytes(frame))
	let body = ''
	for (const line of transcript.split('\n')) {
		if (utf8Bytes(body) + utf8Bytes(line) + 1 > budget) break
		body += (body ? '\n' : '') + line
	}
	return frame.replace('{transcript}', body || '(none)')
}

/** One clean comma-separated line out of whatever the model wrote around it. */
export function normalizeGlossary(answer: string) {
	const terms = answer
		.replace(/^```[^\n]*\n?|```$/g, '')
		.split(/[,、\n]+/)
		.map((term) =>
			term
				.replace(/^[\s\-*•\d.)]+/, '')
				.replace(/[\s.。]+$/, '')
				.trim(),
		)
		.filter(Boolean)
	const unique = [...new Set(terms)]
	let line = ''
	for (const term of unique) {
		const next = line ? `${line}, ${term}` : term
		if (next.length > GLOSSARY_MAX_CHARS) break
		line = next
	}
	return line
}

export async function generateGlossary(client: AiClient, input: GlossaryInput) {
	try {
		return normalizeGlossary(await client.ask(buildGlossaryPrompt(input)))
	} finally {
		// One-off job: the AI model must not stay on the GPU beside the speech model afterwards.
		await client.release().catch((error) => console.warn('releasing the AI model failed', error))
	}
}

/**
 * The prompt Whisper actually gets: the one from the settings first — it is prose the model
 * imitates for style and spelling — and the glossary last, because Whisper reads only the tail.
 */
export function combinePrompt(settingsPrompt: string | null | undefined, glossary: string | null | undefined) {
	const parts = [settingsPrompt?.trim(), glossary?.trim()].filter((part): part is string => Boolean(part))
	return parts.length ? parts.join('\n') : null
}
