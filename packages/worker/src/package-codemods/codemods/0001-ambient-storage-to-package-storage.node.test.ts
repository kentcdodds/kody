import { expect, test } from 'vitest'
import { ambientStorageToPackageStorageCodemod } from './0001-ambient-storage-to-package-storage.ts'

function exportOnlyManifest(name = '@user/demo', kodyId = 'demo') {
	return `${JSON.stringify(
		{
			name,
			exports: { '.': './index.ts' },
			kody: {
				id: kodyId,
				description: 'Demo package for ambient storage codemod tests.',
			},
		},
		null,
		'\t',
	)}\n`
}

function appManifest() {
	return `${JSON.stringify(
		{
			name: '@user/app',
			exports: { '.': './index.ts' },
			kody: {
				id: 'app',
				description: 'App package that must not auto-migrate ambient storage.',
				app: { entry: './app.ts' },
			},
		},
		null,
		'\t',
	)}\n`
}

test('0001 rewrites member call sites, gates apps, verifies AST, and handles parse failures', () => {
	const plain = {
		'package.json': exportOnlyManifest(),
		'index.ts':
			"import { storage } from 'kody:runtime'\n\nexport async function run() {\n\treturn storage.get('k')\n}\n",
	}
	const plainDetect = ambientStorageToPackageStorageCodemod.detect(plain)
	expect(plainDetect).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('ambient `storage`'),
		},
	])
	const plainTransform = ambientStorageToPackageStorageCodemod.transform(plain)
	expect(plainTransform.changed).toBe(true)
	expect(plainTransform.changedPaths).toEqual(['index.ts'])
	expect(plainTransform.needsManual).toEqual([])
	expect(plainTransform.files['index.ts']).toContain(
		"import { packageStorage } from 'kody:runtime'",
	)
	expect(plainTransform.files['index.ts']).toContain(
		"packageStorage().get('k')",
	)
	expect(plainTransform.files['index.ts']).not.toContain(
		'const storage = packageStorage()',
	)
	expect(plainTransform.files['index.ts']).not.toMatch(
		/(?<!package)storage\.get/,
	)

	const secondPass = ambientStorageToPackageStorageCodemod.transform(
		plainTransform.files,
	)
	expect(secondPass.changed).toBe(false)
	expect(secondPass.files['index.ts']).toBe(plainTransform.files['index.ts'])

	const mixed = {
		'package.json': exportOnlyManifest('@user/mixed', 'mixed'),
		'lib.ts':
			"import { kody, storage, packages } from 'kody:runtime'\nexport const value = storage.sql`select 1`\nexport const other = kody\nexport const pack = packages\n",
	}
	const mixedTransform = ambientStorageToPackageStorageCodemod.transform(mixed)
	expect(mixedTransform.changed).toBe(true)
	expect(mixedTransform.files['lib.ts']).toContain('packageStorage().sql')
	expect(mixedTransform.files['lib.ts']).toContain('kody')
	expect(mixedTransform.files['lib.ts']).toContain('packages')
	expect(mixedTransform.files['lib.ts']).not.toMatch(
		/import\s*\{[^}]*\bstorage\b/,
	)

	const aliased = {
		'package.json': exportOnlyManifest('@user/alias', 'alias'),
		'alias.ts':
			"import { storage as packageBucket } from 'kody:runtime'\nexport const value = packageBucket.get('k')\n",
	}
	const aliasedTransform =
		ambientStorageToPackageStorageCodemod.transform(aliased)
	expect(aliasedTransform.changed).toBe(false)
	expect(aliasedTransform.files['alias.ts']).toBe(aliased['alias.ts'])
	expect(aliasedTransform.needsManual).toEqual([
		{
			path: 'alias.ts',
			message: expect.stringContaining('alias'),
		},
	])

	const valuePass = {
		'package.json': exportOnlyManifest('@user/value', 'value'),
		'value.ts':
			"import { storage } from 'kody:runtime'\nexport function wrap(helper) {\n\treturn helper(storage)\n}\n",
	}
	const valueTransform =
		ambientStorageToPackageStorageCodemod.transform(valuePass)
	expect(valueTransform.changed).toBe(false)
	expect(valueTransform.needsManual[0]?.message).toMatch(/member-expression/i)

	const appPackage = {
		'package.json': appManifest(),
		'index.ts':
			"import { storage } from 'kody:runtime'\nexport const run = () => storage.get('k')\n",
	}
	const appTransform =
		ambientStorageToPackageStorageCodemod.transform(appPackage)
	expect(appTransform.changed).toBe(false)
	expect(appTransform.needsManual).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('bucket identities'),
		},
	])
	expect(appTransform.files['index.ts']).toBe(appPackage['index.ts'])

	const commentTrap = {
		'package.json': exportOnlyManifest('@user/comment', 'comment'),
		'comment.ts':
			"import { storage } from 'kody:runtime'\n// const storage = packageStorage()\nexport const run = () => storage.get('k')\n",
	}
	const commentTransform =
		ambientStorageToPackageStorageCodemod.transform(commentTrap)
	expect(commentTransform.changed).toBe(true)
	expect(commentTransform.files['comment.ts']).toContain(
		"packageStorage().get('k')",
	)
	expect(commentTransform.files['comment.ts']).toContain(
		'// const storage = packageStorage()',
	)

	const stringTrap = {
		'package.json': exportOnlyManifest('@user/string', 'string'),
		'string.ts':
			"import { storage } from 'kody:runtime'\nconst note = 'const storage = packageStorage()'\nexport const run = () => storage.get('k')\n",
	}
	const stringTransform =
		ambientStorageToPackageStorageCodemod.transform(stringTrap)
	expect(stringTransform.changed).toBe(true)
	expect(stringTransform.files['string.ts']).toContain(
		"packageStorage().get('k')",
	)
	expect(stringTransform.files['string.ts']).toContain(
		"'const storage = packageStorage()'",
	)

	const unparseable = {
		'package.json': exportOnlyManifest('@user/bad', 'bad'),
		'bad.ts':
			"import { storage } from 'kody:runtime'\nexport function broken( {\n",
	}
	const unparseableDetect =
		ambientStorageToPackageStorageCodemod.detect(unparseable)
	expect(unparseableDetect).toEqual([
		{
			path: 'bad.ts',
			message: expect.stringContaining('could not be parsed'),
		},
	])
	const unparseableTransform =
		ambientStorageToPackageStorageCodemod.transform(unparseable)
	expect(unparseableTransform.changed).toBe(false)
	expect(unparseableTransform.needsManual).toEqual([
		{
			path: 'bad.ts',
			message: expect.stringContaining('could not be parsed'),
		},
	])

	const clean = {
		'package.json': exportOnlyManifest('@user/clean', 'clean'),
		'clean.ts':
			"import { packageStorage } from 'kody:runtime'\nexport const run = () => packageStorage().get('k')\n",
	}
	expect(ambientStorageToPackageStorageCodemod.detect(clean)).toEqual([])
	expect(ambientStorageToPackageStorageCodemod.transform(clean).changed).toBe(
		false,
	)
})
