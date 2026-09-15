import { describe, expect, it } from 'vitest'
import { liveLanguage } from './live-language'

const nemotron = { languages: ['en-US', 'ja-JP', 'de-DE'], language_detection: true }
const whisper = { languages: ['en', 'ja', 'de'], language_detection: true }

describe('liveLanguage', () => {
	it('keeps a language the live model lists', () => {
		expect(liveLanguage('ja-JP', nemotron)).toBe('ja-JP')
		expect(liveLanguage('ja', whisper)).toBe('ja')
	})

	it('keeps auto', () => {
		expect(liveLanguage('auto', nemotron)).toBe('auto')
	})

	it('translates between the engines by base code', () => {
		expect(liveLanguage('ja', nemotron)).toBe('ja-JP')
		expect(liveLanguage('ja-JP', whisper)).toBe('ja')
	})

	it('falls back to auto when the live model cannot name the language', () => {
		expect(liveLanguage('xx', nemotron)).toBe('auto')
		expect(liveLanguage('xx', { languages: ['en'], language_detection: false })).toBe('xx')
	})

	it('passes through without capabilities', () => {
		expect(liveLanguage('ja', null)).toBe('ja')
	})
})
