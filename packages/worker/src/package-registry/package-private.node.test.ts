import { expect, test } from 'vitest'
import {
	assertPackageNotPrivateForCommunityPublish,
	injectDefaultPrivateField,
	isPackagePrivate,
	packagePrivateFieldChanged,
	parsePackagePrivateField,
	requiresPrivateVisibilityConfirmation,
} from './package-private.ts'

test('package private parsing gates community publish and visibility confirmation', () => {
	expect(parsePackagePrivateField('{"name":"@a/b"}')).toBeUndefined()
	expect(parsePackagePrivateField('{"private":true}')).toBe(true)
	expect(parsePackagePrivateField('{"private":false}')).toBe(false)
	expect(() => parsePackagePrivateField('{"private":"yes"}')).toThrow(
		'must be a boolean',
	)

	expect(() =>
		assertPackageNotPrivateForCommunityPublish('{"private":true}'),
	).toThrow('community listings cannot publish packages')
	expect(() =>
		assertPackageNotPrivateForCommunityPublish('{"private":false}'),
	).not.toThrow()
	expect(() => assertPackageNotPrivateForCommunityPublish('{}')).not.toThrow()

	expect(
		packagePrivateFieldChanged('{"private":true}', '{"private":false}'),
	).toBe(true)
	expect(
		packagePrivateFieldChanged('{"private":true}', '{"private":true}'),
	).toBe(false)
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

	const defaulted = injectDefaultPrivateField('{"name":"@a/b"}\n')
	expect(isPackagePrivate(defaulted)).toBe(true)
	const explicit = injectDefaultPrivateField(
		'{"name":"@a/b","private":false}\n',
	)
	expect(parsePackagePrivateField(explicit)).toBe(false)
})
