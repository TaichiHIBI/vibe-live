import { describe, expect, it } from 'vitest'
import { buildGlossaryPrompt, combinePrompt, GLOSSARY_MAX_CHARS, normalizeGlossary } from './glossary'

describe('normalizeGlossary', () => {
	it('turns a list in any shape into one comma-separated line', () => {
		expect(normalizeGlossary('コーシー列、完備\n- 正定値カーネル\n2. RKHS.')).toBe('コーシー列, 完備, 正定値カーネル, RKHS')
	})

	it('drops duplicates and fences', () => {
		expect(normalizeGlossary('```\n内積, 内積, 線形代数\n```')).toBe('内積, 線形代数')
	})

	it('stays within the length Whisper will actually read', () => {
		const long = Array.from({ length: 200 }, (_, index) => `term${index}`).join(', ')
		expect(normalizeGlossary(long).length).toBeLessThanOrEqual(GLOSSARY_MAX_CHARS)
	})
})

describe('buildGlossaryPrompt', () => {
	it('carries the topic, the language and as much transcript as fits', () => {
		const prompt = buildGlossaryPrompt({ topic: 'RKHS lecture', transcript: 'line one\nline two', language: 'Japanese', contextTokens: 8_000 })
		expect(prompt).toContain('RKHS lecture')
		expect(prompt).toContain('Japanese')
		expect(prompt).toContain('line one\nline two')
	})

	it('cuts the transcript between lines when the context is small', () => {
		const transcript = Array.from({ length: 50 }, (_, index) => `line ${index} ${'x'.repeat(100)}`).join('\n')
		const prompt = buildGlossaryPrompt({ topic: '', transcript, language: 'en', contextTokens: 3_000 })
		expect(prompt).toContain('line 0')
		expect(prompt).not.toContain('line 49')
		expect(prompt).toContain('(unknown)')
	})
})

describe('combinePrompt', () => {
	it('puts the settings prose first and the glossary last', () => {
		expect(combinePrompt('本日は ViT について。', 'コーシー列, 完備')).toBe('本日は ViT について。\nコーシー列, 完備')
	})

	it('drops whatever is missing', () => {
		expect(combinePrompt('  ', 'RKHS')).toBe('RKHS')
		expect(combinePrompt('prose', '')).toBe('prose')
		expect(combinePrompt(null, undefined)).toBeNull()
	})
})
