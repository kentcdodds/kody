import { expect, test } from 'vitest'
import {
	applyPackageNameAliases,
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
			value: '@grant/mailchimp',
			ownerScope: 'kentcdodds',
		}),
	).toThrow(/does not match the acting owner "@kentcdodds"/)

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

	expect(() =>
		normalizePackageNameInput({
			value: '@grant/Not_Valid',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(/lower-kebab-case package name leaf/)

	expect(getPackageNameLeaf('@kentcdodds/cursor-cloud-agents')).toBe(
		'cursor-cloud-agents',
	)
	expect(getPackageNameScope('@kentcdodds/cursor-cloud-agents')).toBe(
		'kentcdodds',
	)
	expect(applyPackageNameAliases({ kody_id: 'legacy-slug' })).toEqual({
		package_name: 'legacy-slug',
	})
	expect(
		applyPackageNameAliases({ package_name: 'kept', kody_id: 'ignored' }),
	).toEqual({ package_name: 'kept' })
})
