import { expect, test } from 'vitest'
import { kodyDependenciesToWildcardMapCodemod } from './0005-kody-dependencies-to-wildcard-map.ts'

function manifest(kodyExtra: Record<string, unknown> = {}) {
	return `${JSON.stringify(
		{
			name: '@user/demo',
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for kody.dependencies map codemod tests.',
				...kodyExtra,
			},
		},
		null,
		'\t',
	)}\n`
}

test('0005 rewrites array and latest-alias maps to name-to-* and is idempotent', () => {
	const arrayFiles = {
		'package.json': manifest({
			dependencies: ['@user/helper', '@other/lib'],
		}),
		'index.ts': 'export const ready = true\n',
	}
	const arrayDetect = kodyDependenciesToWildcardMapCodemod.detect(arrayFiles)
	expect(arrayDetect).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('array-shaped'),
		},
	])
	const arrayTransform =
		kodyDependenciesToWildcardMapCodemod.transform(arrayFiles)
	expect(arrayTransform.changed).toBe(true)
	expect(arrayTransform.changedPaths).toEqual(['package.json'])
	expect(arrayTransform.needsManual).toEqual([])
	expect(
		JSON.parse(arrayTransform.files['package.json']!).kody.dependencies,
	).toEqual({
		'@other/lib': '*',
		'@user/helper': '*',
	})
	expect(arrayTransform.files['index.ts']).toBe(arrayFiles['index.ts'])

	const secondPass = kodyDependenciesToWildcardMapCodemod.transform(
		arrayTransform.files,
	)
	expect(secondPass.changed).toBe(false)
	expect(secondPass.files['package.json']).toBe(
		arrayTransform.files['package.json'],
	)
	expect(
		kodyDependenciesToWildcardMapCodemod.detect(arrayTransform.files),
	).toEqual([])

	const aliasFiles = {
		'package.json': manifest({
			dependencies: {
				'@user/helper': 'latest',
				'@other/lib': '*',
			},
		}),
	}
	const aliasDetect = kodyDependenciesToWildcardMapCodemod.detect(aliasFiles)
	expect(aliasDetect).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('normalizes to "*"'),
		},
	])
	const aliasTransform =
		kodyDependenciesToWildcardMapCodemod.transform(aliasFiles)
	expect(aliasTransform.changed).toBe(true)
	expect(
		JSON.parse(aliasTransform.files['package.json']!).kody.dependencies,
	).toEqual({
		'@other/lib': '*',
		'@user/helper': '*',
	})

	const emptyArray = {
		'package.json': manifest({ dependencies: [] }),
	}
	const emptyTransform =
		kodyDependenciesToWildcardMapCodemod.transform(emptyArray)
	expect(emptyTransform.changed).toBe(true)
	expect(
		JSON.parse(emptyTransform.files['package.json']!).kody.dependencies,
	).toEqual({})

	const alreadyMigrated = {
		'package.json': manifest({
			dependencies: { '@user/helper': '*' },
		}),
	}
	expect(kodyDependenciesToWildcardMapCodemod.detect(alreadyMigrated)).toEqual(
		[],
	)
	expect(
		kodyDependenciesToWildcardMapCodemod.transform(alreadyMigrated).changed,
	).toBe(false)
})

test('0005 leaves unsupported shapes for manual review and skips missing manifests', () => {
	const semverFiles = {
		'package.json': manifest({
			dependencies: { '@user/helper': '^1.2.3' },
		}),
	}
	expect(kodyDependenciesToWildcardMapCodemod.detect(semverFiles)).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('review and update manually'),
		},
	])
	const semverTransform =
		kodyDependenciesToWildcardMapCodemod.transform(semverFiles)
	expect(semverTransform.changed).toBe(false)
	expect(semverTransform.files['package.json']).toBe(
		semverFiles['package.json'],
	)
	expect(semverTransform.needsManual).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('review and update manually'),
		},
	])

	const invalidName = {
		'package.json': manifest({
			dependencies: ['helper', '@user/ok'],
		}),
	}
	const invalidNameTransform =
		kodyDependenciesToWildcardMapCodemod.transform(invalidName)
	expect(invalidNameTransform.changed).toBe(false)
	expect(invalidNameTransform.needsManual).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('not scoped package names'),
		},
	])

	const noManifest = {
		'index.ts': 'export const ready = true\n',
	}
	expect(kodyDependenciesToWildcardMapCodemod.detect(noManifest)).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('missing or not valid JSON'),
		},
	])

	const noKody = {
		'package.json': `${JSON.stringify({ name: '@user/demo' }, null, '\t')}\n`,
	}
	expect(kodyDependenciesToWildcardMapCodemod.detect(noKody)).toEqual([])
	expect(kodyDependenciesToWildcardMapCodemod.transform(noKody).changed).toBe(
		false,
	)
})
