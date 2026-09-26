import * as clipboard from '@tauri-apps/plugin-clipboard-manager'
import { ClipboardCopy, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { m } from '~/paraglide/messages.js'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Spinner } from '~/components/ui/spinner'
import { Textarea } from '~/components/ui/textarea'
import { buildGlossaryPrompt, createClient, generateGlossary, normalizeGlossary } from '~/lib/ai'
import { usePreferenceProvider } from '~/providers/preference'

/** What a word list is written from: the transcript so far (none yet for live) and its language. */
export interface VocabularySource {
	transcript: string
	language: string
}

/** A chat window takes far more than the AI connection may; this only keeps the pasted prompt sane. */
const CHAT_CONTEXT_TOKENS = 32_000

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * The word list Whisper gets as its prompt. It is typed or pasted by hand; the AI connection
 * (Ollama or an API) can fill it in, and so can a chat subscription: the prompt goes to the
 * clipboard, and the reply comes back into the list.
 */
export function VocabularyEditor({
	value,
	onChange,
	topic,
	onTopicChange,
	source,
}: {
	value: string
	onChange: (value: string) => void
	topic: string
	onTopicChange: (topic: string) => void
	source: () => Promise<VocabularySource>
}) {
	const preference = usePreferenceProvider()
	const [generating, setGenerating] = useState(false)

	async function generate() {
		setGenerating(true)
		try {
			const { transcript, language } = await source()
			const list = await generateGlossary(createClient(preference.ai.connection), {
				topic,
				transcript,
				language,
				contextTokens: preference.ai.connection.contextTokens,
			})
			// Words typed by hand stay first: the list is cut from the end once it runs long.
			if (list) onChange(normalizeGlossary(value.trim() ? `${value}, ${list}` : list))
			else toast.warning(m.vocabularyGenerateFailed(), { position: 'bottom-center' })
		} catch (error) {
			console.error('word list generation failed', error)
			toast.warning(m.vocabularyGenerateFailed(), { description: errorText(error), position: 'bottom-center' })
		} finally {
			setGenerating(false)
		}
	}

	async function copyPrompt() {
		try {
			const { transcript, language } = await source()
			await clipboard.writeText(buildGlossaryPrompt({ topic, transcript, language, contextTokens: CHAT_CONTEXT_TOKENS }))
			toast.success(m.vocabularyCopied(), { description: m.vocabularyCopiedInfo(), position: 'bottom-center', duration: 8000 })
		} catch (error) {
			console.error('copying the word list prompt failed', error)
			toast.error(errorText(error), { position: 'bottom-center' })
		}
	}

	return (
		<div className="space-y-2">
			<Textarea
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={m.vocabularyListPlaceholder()}
				aria-label={m.vocabularyList()}
				rows={3}
				className="rounded-xl"
			/>
			<Input
				value={topic}
				onChange={(event) => onTopicChange(event.target.value)}
				placeholder={m.vocabularyTopicPlaceholder()}
				aria-label={m.vocabularyTopic()}
				className="h-10 rounded-xl"
			/>
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onClick={() => void generate()} disabled={generating}>
					{generating ? <Spinner className="h-4 w-4" /> : <Sparkles />}
					{m.vocabularyWithAi()}
				</Button>
				<Button variant="outline" size="sm" onClick={() => void copyPrompt()}>
					<ClipboardCopy />
					{m.vocabularyCopyPrompt()}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">{m.vocabularyListInfo()}</p>
		</div>
	)
}
