import { expect, test } from 'vitest'
import { buildPackageStorageId, packageIdFromStorageId } from './storage-ids.ts'

test('packageIdFromStorageId reads package buckets and leaves ad hoc ids null', () => {
	const packageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
	expect(packageIdFromStorageId(buildPackageStorageId(packageId))).toBe(
		packageId,
	)
	expect(packageIdFromStorageId(packageId)).toBe(packageId)
	expect(packageIdFromStorageId(`${packageId}:app`)).toBe(packageId)
	expect(packageIdFromStorageId(`job:package-job:${packageId}:nightly`)).toBe(
		packageId,
	)
	expect(packageIdFromStorageId('exec:abc')).toBeNull()
	expect(packageIdFromStorageId('job:adhoc-1')).toBeNull()
})
