import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	readInventoriedStorageBucketEstimatedBytes: vi.fn(),
	listStorageBucketsMissingEstimates: vi.fn(),
	registerMissingRepoSessionStorageBuckets: vi.fn(async () => 0),
	updateStorageBucketEstimate: vi.fn(async () => true),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	readInventoriedStorageBucketEstimatedBytes: (...args: Array<unknown>) =>
		mockModule.readInventoriedStorageBucketEstimatedBytes(...args),
}))

vi.mock('./service.ts', () => ({
	listStorageBucketsMissingEstimates: (...args: Array<unknown>) =>
		mockModule.listStorageBucketsMissingEstimates(...args),
	registerMissingRepoSessionStorageBuckets: (...args: Array<unknown>) =>
		mockModule.registerMissingRepoSessionStorageBuckets(...args),
	updateStorageBucketEstimate: (...args: Array<unknown>) =>
		mockModule.updateStorageBucketEstimate(...args),
}))

const { backfillStorageBucketEstimates } =
	await import('./estimate-backfill.ts')

test('backfill tolerates per-bucket probe failures and keeps sweeping peers', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listStorageBucketsMissingEstimates.mockResolvedValue([
		{ userId: 'user-1', storageId: 'package:healthy-a', kind: 'package' },
		{
			userId: 'user-1',
			storageId: 'repo-session:unreachable',
			kind: 'repo_session',
		},
		{ userId: 'user-2', storageId: 'exec:healthy-b', kind: 'execute' },
	])
	mockModule.readInventoriedStorageBucketEstimatedBytes.mockImplementation(
		async (input: { storageId: string }) => {
			if (input.storageId === 'repo-session:unreachable') {
				throw new Error('estimate read failed after every attempt')
			}
			return 2048
		},
	)

	await expect(
		backfillStorageBucketEstimates({ env: { APP_DB: {} } as Env }),
	).resolves.toEqual({ scanned: 3, updated: 2, failed: 1 })

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
			userId: 'user-1',
			storageId: 'package:healthy-a',
			estimatedBytes: 2048,
		}),
	)
	expect(mockModule.updateStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-2',
			storageId: 'exec:healthy-b',
			estimatedBytes: 2048,
		}),
	)
})
