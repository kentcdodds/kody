import { expect, test } from 'vitest'
import {
	diagnoseHandleFormat,
	getHandleFormatError,
	isValidHandle,
	normalizeHandle,
	suggestHandle,
} from './handle-rules.ts'

test('normalizeHandle trims and lowercases', () => {
	expect(normalizeHandle('  Kent ')).toBe('kent')
	expect(normalizeHandle(null)).toBe('')
})

test('suggestHandle strips diacritics, spaces, and punctuation', () => {
	expect(suggestHandle('Ján Kováč')).toBe('jan-kovac')
	expect(suggestHandle('Jozef Novak')).toBe('jozef-novak')
	expect(suggestHandle('joe_cool')).toBe('joe-cool')
	expect(suggestHandle('john.doe')).toBe('john-doe')
	expect(suggestHandle('  Trailing Space  ')).toBe('trailing-space')
	expect(suggestHandle('ab')).toBeNull()
	expect(suggestHandle('---')).toBeNull()
	expect(suggestHandle('Pinned 1234567890')).toBe('pinned-1234567890')
})

test('diagnoseHandleFormat covers spaces, diacritics, length, and edge hyphens', () => {
	expect(diagnoseHandleFormat('')).toBe('required')
	expect(diagnoseHandleFormat('   ')).toBe('required')
	expect(diagnoseHandleFormat('joe cool')).toBe('spaces')
	expect(diagnoseHandleFormat('Ján')).toBe('diacritics')
	expect(diagnoseHandleFormat('joe_cool')).toBe('underscores')
	expect(diagnoseHandleFormat('john.doe')).toBe('dots')
	expect(diagnoseHandleFormat('ab')).toBe('too-short')
	expect(diagnoseHandleFormat('a'.repeat(33))).toBe('too-long')
	expect(diagnoseHandleFormat('-joe')).toBe('leading-hyphen')
	expect(diagnoseHandleFormat('joe-')).toBe('trailing-hyphen')
	expect(diagnoseHandleFormat('joe!')).toBe('other-characters')
	expect(diagnoseHandleFormat('some-user')).toBeNull()
	// Trailing whitespace alone does not fail once trimmed.
	expect(diagnoseHandleFormat('kent ')).toBeNull()
	expect(diagnoseHandleFormat('  kent')).toBeNull()
})

test('getHandleFormatError names the problem and suggests a fix', () => {
	expect(getHandleFormatError('Jozef Novak')).toBe(
		"Username can't include spaces. Try jozef-novak.",
	)
	expect(getHandleFormatError('Ján Kováč')).toBe(
		'Username can only use a–z letters (no accents), numbers, and hyphens. Try jan-kovac.',
	)
	expect(getHandleFormatError('joe_cool', { label: 'Handle' })).toBe(
		"Handle can't include underscores. Try joe-cool.",
	)
	expect(getHandleFormatError('ab')).toBe(
		'Username must be at least 3 characters.',
	)
	expect(getHandleFormatError('kent ')).toBeNull()
	expect(getHandleFormatError('valid-handle')).toBeNull()
})

test('isValidHandle matches the DNS-safe username pattern', () => {
	expect(isValidHandle('kent')).toBe(true)
	expect(isValidHandle('Kent')).toBe(true)
	expect(isValidHandle('kent ')).toBe(true)
	expect(isValidHandle('kent_cdodds')).toBe(false)
	expect(isValidHandle('ján')).toBe(false)
})
