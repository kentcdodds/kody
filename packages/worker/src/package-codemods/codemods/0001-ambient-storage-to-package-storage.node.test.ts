import { expect, test } from 'vitest'
import { ambientStorageToPackageStorageCodemod } from './0001-ambient-storage-to-package-storage.ts'

test('0001 migrates plain and mixed ambient storage imports, leaves aliases for manual work, and is idempotent', () => {
	const plain = {
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
		'const storage = packageStorage()',
	)
	expect(plainTransform.files['index.ts']).toContain("storage.get('k')")
	expect(plainTransform.files['index.ts']).not.toMatch(
		/import\s*\{\s*storage[\s,}]/,
	)

	const secondPass = ambientStorageToPackageStorageCodemod.transform(
		plainTransform.files,
	)
	expect(secondPass.changed).toBe(false)
	expect(secondPass.changedPaths).toEqual([])
	expect(secondPass.files['index.ts']).toBe(plainTransform.files['index.ts'])
	expect(
		ambientStorageToPackageStorageCodemod.detect(plainTransform.files),
	).toEqual([])

	const mixed = {
		'lib.ts':
			"import { kody, storage, packages } from 'kody:runtime'\nexport const value = storage\n",
	}
	const mixedTransform = ambientStorageToPackageStorageCodemod.transform(mixed)
	expect(mixedTransform.changed).toBe(true)
	expect(mixedTransform.files['lib.ts']).toContain('packageStorage')
	expect(mixedTransform.files['lib.ts']).toContain('kody')
	expect(mixedTransform.files['lib.ts']).toContain('packages')
	expect(mixedTransform.files['lib.ts']).toContain(
		'const storage = packageStorage()',
	)
	expect(mixedTransform.files['lib.ts']).not.toMatch(
		/import\s*\{[^}]*\bstorage\b/,
	)

	const aliased = {
		'alias.ts':
			"import { storage as packageBucket } from 'kody:runtime'\nexport const value = packageBucket\n",
	}
	const aliasedDetect = ambientStorageToPackageStorageCodemod.detect(aliased)
	expect(aliasedDetect).toHaveLength(1)
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

	const clean = {
		'clean.ts':
			"import { packageStorage } from 'kody:runtime'\nconst storage = packageStorage()\nexport const value = storage\n",
		'readme.md': 'no code',
	}
	expect(ambientStorageToPackageStorageCodemod.detect(clean)).toEqual([])
	const cleanTransform = ambientStorageToPackageStorageCodemod.transform(clean)
	expect(cleanTransform.changed).toBe(false)
	expect(cleanTransform.needsManual).toEqual([])
	expect(cleanTransform.files).toEqual(clean)
})
