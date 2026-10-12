import { expect, test } from 'vitest'
import {
	assertNoUnfilledBase64Placeholder,
	assertNoUnfilledEncodedPlaceholder,
	EncodedPlaceholderError,
	encodedPlaceholderRefusalMessage,
	holdsUnfilledEncodedPlaceholder,
} from './encoded-placeholder.ts'

test('refuses percent-encoded secret placeholders', () => {
	expect(() =>
		assertNoUnfilledEncodedPlaceholder('%7B%7Bsecret%3Atoken%7D%7D'),
	).toThrow(EncodedPlaceholderError)
	expect(holdsUnfilledEncodedPlaceholder('%7b%7bsecret%3aname%7d%7d')).toBe(
		true,
	)
	expect(encodedPlaceholderRefusalMessage('percent')).toContain(
		'percent-encoded',
	)
})

test('refuses base64-encoded secret placeholder openers', () => {
	const opener = btoa('{{secret:')
	expect(() => assertNoUnfilledEncodedPlaceholder(`xx${opener}yy`)).toThrow(
		EncodedPlaceholderError,
	)
})

test('allows literal placeholders', () => {
	expect(() =>
		assertNoUnfilledEncodedPlaceholder('Bearer {{secret:token}}'),
	).not.toThrow()
	expect(holdsUnfilledEncodedPlaceholder('Bearer {{secret:token}}')).toBe(false)
})

test('base64-only assert allows percent-encoded forms', () => {
	expect(() =>
		assertNoUnfilledBase64Placeholder('%7B%7Bsecret%3Atoken%7D%7D'),
	).not.toThrow()
	const opener = btoa('{{secret:')
	expect(() => assertNoUnfilledBase64Placeholder(`x${opener}y`)).toThrow(
		EncodedPlaceholderError,
	)
})
