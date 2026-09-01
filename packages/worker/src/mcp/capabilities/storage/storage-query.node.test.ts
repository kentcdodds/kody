import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'

const mockModule = vi.hoisted(() => ({
	sqlQuery: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	assertStorageRunnerWriteWithinEntitlement: vi.fn(),
	isReadOnlyStorageSqlQuery: (query: string) =>
		query.trim().toLowerCase().startsWith('select'),
	storageRunnerRpc: () => ({
		sqlQuery: (...args: Array<unknown>) => mockModule.sqlQuery(...args),
	}),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	estimateEntitlementStorageSqlWriteBytes: () => 0,
}))

const { storageQueryCapability } = await import('./storage-query.ts')

function createCallerContext() {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
	})
}

function createPackageCallerContext(packageId: string) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		executionOrigin: 'background',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
		storageContext: {
			sessionId: null,
			appId: packageId,
			packageId,
			storageId: buildPackageStorageId(packageId),
		},
	})
}

test('storage_query wraps Durable Object SQL caller mistakes and rethrows platform failures', async () => {
	mockModule.sqlQuery.mockRejectedValueOnce(
		new Error('no such table: articles: SQLITE_ERROR'),
	)

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'storage-1',
				query: 'SELECT * FROM articles',
			},
			{
				env: {} as Env,
				callerContext: createCallerContext(),
			} as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'no such table: articles: SQLITE_ERROR',
	)

	const platformError = new Error(
		'Durable Object reset because its code was updated.',
	)
	mockModule.sqlQuery.mockRejectedValueOnce(platformError)

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'storage-1',
				query: 'SELECT 1',
			},
			{
				env: {} as Env,
				callerContext: createCallerContext(),
			} as never,
		),
	).rejects.toBe(platformError)
})

test('storage_query denies package runtimes buckets their package does not own', async () => {
	const packageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
	const victimPackageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
	mockModule.sqlQuery.mockClear()

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: buildPackageStorageId(victimPackageId),
				query: 'SELECT * FROM secrets',
			},
			{
				env: {} as Env,
				callerContext: createPackageCallerContext(packageId),
			} as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes(buildPackageStorageId(victimPackageId)),
	)
	expect(mockModule.sqlQuery).not.toHaveBeenCalled()

	mockModule.sqlQuery.mockResolvedValueOnce({
		columns: ['id'],
		rows: [{ id: 1 }],
		rowCount: 1,
		rowsRead: 1,
		rowsWritten: 0,
	})
	const ownBucketResult = await storageQueryCapability.handler(
		{
			storage_id: buildPackageStorageId(packageId),
			query: 'SELECT id FROM notes',
		},
		{
			env: {} as Env,
			callerContext: createPackageCallerContext(packageId),
		} as never,
	)
	expect(ownBucketResult.storage_id).toBe(buildPackageStorageId(packageId))
})
