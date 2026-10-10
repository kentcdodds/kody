import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as StorageRunner from '#worker/storage-runner.ts'
import type * as StorageBucketsService from './service.ts'

const mockModule = vi.hoisted(() => ({
	readInventoriedStorageBucketEstimatedBytes:
		vi.fn<typeof StorageRunner.readInventoriedStorageBucketEstimatedBytes>(),
	listStorageBucketsMissingEstimates:
		vi.fn<typeof StorageBucketsService.listStorageBucketsMissingEstimates>(),
	registerMissingRepoSessionStorageBuckets: vi.fn<
		typeof StorageBucketsService.registerMissingRepoSessionStorageBuckets
	>(async () => 0),
	updateStorageBucketEstimate: vi.fn<
		typeof StorageBucketsService.updateStorageBucketEstimate
	>(async () => true),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	readInventoriedStorageBucketEstimatedBytes: (
		...args: Parameters<
			typeof StorageRunner.readInventoriedStorageBucketEstimatedBytes
		>
	) => mockModule.readInventoriedStorageBucketEstimatedBytes(...args),
}))

vi.mock('./service.ts', () => ({
	listStorageBucketsMissingEstimates: (
		...args: Parameters<
			typeof StorageBucketsService.listStorageBucketsMissingEstimates
		>
	) => mockModule.listStorageBucketsMissingEstimates(...args),
	registerMissingRepoSessionStorageBuckets: (
		...args: Parameters<
			typeof StorageBucketsService.registerMissingRepoSessionStorageBuckets
		>
	) => mockModule.registerMissingRepoSessionStorageBuckets(...args),
	updateStorageBucketEstimate: (
		...args: Parameters<
			typeof StorageBucketsService.updateStorageBucketEstimate
		>
	) => mockModule.updateStorageBucketEstimate(...args),
}))

const { backfillStorageBucketEstimates } =
	await import('./estimate-backfill.ts')

test('backfill tolerates per-bucket probe failures and keeps sweeping peers', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listStorageBucketsMissingEstimates.mockResolvedValue([
		{
			userId: ownerIdFromStored('user-1'),
			storageId: 'package:healthy-a',
			kind: 'package',
		},
		{
			userId: ownerIdFromStored('user-1'),
			storageId: 'repo-session:unreachable',
			kind: 'repo_session',
		},
		{
			userId: ownerIdFromStored('user-2'),
			storageId: 'exec:healthy-b',
			kind: 'execute',
		},
	])
	mockModule.readInventoriedStorageBucketEstimatedBytes.mockImplementation(
		async (input) => {
			if (input.storageId === 'repo-session:unreachable') {
				throw new Error('estimate read failed after every attempt')
			}
			return 2048
		},
	)

	const env = { APP_DB: {} } as Env
	await expect(backfillStorageBucketEstimates({ env })).resolves.toEqual({
		scanned: 3,
		updated: 2,
		failed: 1,
	})

	// The failing bucket is logged and left NULL for a later sweep; the two
	// healthy buckets are persisted.
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-estimate-backfill-row-failed',
		'repo-session:unreachable',
		expect.any(Error),
	)
	expect(mockModule.updateStorageBucketEstimate).toHaveBeenCalledTimes(2)
	expect(mockModule.updateStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			storageId: 'package:healthy-a',
			estimatedBytes: 2048,
		}),
	)
	expect(mockModule.updateStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-2'),
			storageId: 'exec:healthy-b',
			estimatedBytes: 2048,
		}),
	)
})
