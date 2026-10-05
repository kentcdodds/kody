import { expect, test } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
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
	).toThrow(CommunityActionError)
	expect(() =>
		assertPackageNotPrivateForCommunityPublish('{"private":true}'),
	).toThrow('cannot be published as a public package')
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
		packagePrivateFieldChanged('{"private":true}', '{"name":"@a/b"}'),
	).toBe(false)
	expect(
		packagePrivateFieldChanged('{"name":"@a/b"}', '{"private":true}'),
	).toBe(false)
	expect(
		packagePrivateFieldChanged('{"private":false}', '{"name":"@a/b"}'),
	).toBe(true)
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
	expect(
		requiresPrivateVisibilityConfirmation({
			beforeContent: '{"name":"@a/b","private":true}',
			afterContent: '{"name":"@a/b"}',
			isNewPackage: false,
		}),
	).toBe(false)

	const defaulted = injectDefaultPrivateField('{"name":"@a/b"}\n')
	expect(isPackagePrivate(defaulted)).toBe(true)
	const explicit = injectDefaultPrivateField(
		'{"name":"@a/b","private":false}\n',
	)
	expect(parsePackagePrivateField(explicit)).toBe(false)
})
