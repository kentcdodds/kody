import { expect, test } from 'vitest'
import {
	getPackageNameLeaf,
	getPackageNameScope,
	invalidPackageNameMessage,
	mismatchedPackageScopeMessage,
	normalizePackageNameInput,
} from './package-name.ts'

test('normalizePackageNameInput accepts a leaf, strips a matching scope, and rejects a foreign scope', () => {
	expect(
		normalizePackageNameInput({
			value: 'mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toBe('mailchimp')
	expect(
		normalizePackageNameInput({
			value: '@grant/mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toBe('mailchimp')
	expect(
		normalizePackageNameInput({
			value: '  @Grant/mailchimp  ',
			ownerScope: '@grant',
			action: 'resolve',
		}),
	).toBe('mailchimp')

	expect(() =>
		normalizePackageNameInput({
			value: '@other/mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(
		mismatchedPackageScopeMessage({
			value: '@other/mailchimp',
			requestedScope: 'other',
			ownerScope: 'grant',
		}),
	)

	expect(() =>
		normalizePackageNameInput({
			value: 'Not_A_Valid_Id',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(
		invalidPackageNameMessage({
			value: 'Not_A_Valid_Id',
			ownerScope: 'grant',
			action: 'create',
		}),
	)

	expect(getPackageNameLeaf('@kentcdodds/cursor-cloud-agents')).toBe(
		'cursor-cloud-agents',
	)
	expect(getPackageNameScope('@kentcdodds/cursor-cloud-agents')).toBe(
		'kentcdodds',
	)
})
