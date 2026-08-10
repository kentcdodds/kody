import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

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
