import { describe, expect, test } from 'vitest'
import {
	assertPackageNotPrivateForCommunityPublish,
	injectDefaultPrivateField,
	isPackagePrivate,
	packagePrivateFieldChanged,
	parsePackagePrivateField,
	requiresPrivateVisibilityConfirmation,
} from './package-private.ts'

describe('parsePackagePrivateField', () => {
	test('returns undefined when private is absent', () => {
		expect(parsePackagePrivateField('{"name":"@a/b"}')).toBeUndefined()
	})

	test('returns boolean values', () => {
		expect(parsePackagePrivateField('{"private":true}')).toBe(true)
		expect(parsePackagePrivateField('{"private":false}')).toBe(false)
	})

	test('rejects non-boolean private values', () => {
		expect(() => parsePackagePrivateField('{"private":"yes"}')).toThrow(
			'must be a boolean',
		)
	})
})

describe('community publish gate', () => {
	test('blocks private packages', () => {
		expect(() =>
			assertPackageNotPrivateForCommunityPublish('{"private":true}'),
		).toThrow('community listings cannot publish packages')
	})

	test('allows public-capable packages', () => {
		expect(() =>
			assertPackageNotPrivateForCommunityPublish('{"private":false}'),
		).not.toThrow()
		expect(() => assertPackageNotPrivateForCommunityPublish('{}')).not.toThrow()
	})
})

describe('private visibility confirmation', () => {
	test('detects field changes', () => {
		expect(
			packagePrivateFieldChanged('{"private":true}', '{"private":false}'),
		).toBe(true)
		expect(
			packagePrivateFieldChanged('{"private":true}', '{"private":true}'),
		).toBe(false)
	})

	test('requires confirmation for new non-private packages', () => {
		expect(
			requiresPrivateVisibilityConfirmation({
				beforeContent: null,
				afterContent: '{"private":false}',
				isNewPackage: true,
			}),
		).toBe(true)
		expect(
			requiresPrivateVisibilityConfirmation({
				beforeContent: null,
				afterContent: '{"private":true}',
				isNewPackage: true,
			}),
		).toBe(false)
	})
})

describe('injectDefaultPrivateField', () => {
	test('adds private true when missing', () => {
		const next = injectDefaultPrivateField('{"name":"@a/b"}\n')
		expect(isPackagePrivate(next)).toBe(true)
	})

	test('preserves an explicit private value', () => {
		const next = injectDefaultPrivateField('{"name":"@a/b","private":false}\n')
		expect(parsePackagePrivateField(next)).toBe(false)
	})
})
