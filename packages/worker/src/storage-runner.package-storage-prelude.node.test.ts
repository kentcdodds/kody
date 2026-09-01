import { expect, test } from 'vitest'
import { createPackageStorageHelperPrelude } from './storage-runner.ts'

test('packageStorage prelude is writable by default and read-only for retrievers', () => {
	expect(createPackageStorageHelperPrelude()).toContain('writable: true')
	expect(createPackageStorageHelperPrelude({ writable: true })).toContain(
		'writable: true',
	)
	expect(createPackageStorageHelperPrelude({ writable: false })).toContain(
		'writable: false',
	)
})
