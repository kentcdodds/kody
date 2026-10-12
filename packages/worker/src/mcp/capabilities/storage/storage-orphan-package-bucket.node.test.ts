import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'

const mocks = vi.hoisted(() => ({
	exportStorage: vi.fn(),
	sqlQuery: vi.fn(),
	getSavedPackageById: vi.fn(),
	authorize: vi.fn(),
	authorizePackageWrite: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	assertStorageRunnerWriteWithinEntitlement: vi.fn(),
	isReadOnlyStorageSqlQuery: (query: string) =>
		query.trim().toLowerCase().startsWith('select'),
	storageRunnerRpc: () => ({
		exportStorage: (...args: Array<unknown>) => mocks.exportStorage(...args),
		sqlQuery: (...args: Array<unknown>) => mocks.sqlQuery(...args),
	}),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	estimateEntitlementStorageSqlWriteBytes: () => 0,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mocks.getSavedPackageById(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		authorize: (...args: Array<unknown>) => mocks.authorize(...args),
		authorizePackageWrite: (...args: Array<unknown>) =>
			mocks.authorizePackageWrite(...args),
	}
})

const { storageExportCapability } = await import('./storage-export.ts')
const { storageQueryCapability } = await import('./storage-query.ts')

const gonePackageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
const plainUuidBucket = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function createContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
		}),
	}
}

test('storageExport denies exact package: buckets when the saved package row is missing', async () => {
	mocks.getSavedPackageById.mockResolvedValue(null)
	mocks.exportStorage.mockResolvedValue({
		entries: [],
		estimatedBytes: 0,
		truncated: false,
		nextStartAfter: null,
		pageSize: 100,
	})

	await expect(
		storageExportCapability.handler(
			{ storage_id: buildPackageStorageId(gonePackageId) },
			createContext() as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes(buildPackageStorageId(gonePackageId)),
	)
	expect(mocks.exportStorage).not.toHaveBeenCalled()
})

test('storageQuery denies exact package: buckets when the saved package row is missing', async () => {
	mocks.getSavedPackageById.mockResolvedValue(null)
	mocks.sqlQuery.mockResolvedValue({
		columns: ['id'],
		rows: [],
		rowCount: 0,
		rowsRead: 0,
		rowsWritten: 0,
		truncated: false,
	})

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: buildPackageStorageId(gonePackageId),
				query: 'SELECT 1',
			},
			createContext() as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes(buildPackageStorageId(gonePackageId)),
	)
	expect(mocks.sqlQuery).not.toHaveBeenCalled()
})

test('storageExport keeps plain UUID buckets reachable when no package row exists', async () => {
	mocks.getSavedPackageById.mockResolvedValue(null)
	mocks.exportStorage.mockResolvedValue({
		entries: [{ key: 'notes', value: {} }],
		estimatedBytes: 12,
		truncated: false,
		nextStartAfter: null,
		pageSize: 100,
	})

	await expect(
		storageExportCapability.handler(
			{ storage_id: plainUuidBucket },
			createContext() as never,
		),
	).resolves.toMatchObject({
		storage_id: plainUuidBucket,
	})
	expect(mocks.exportStorage).toHaveBeenCalled()
	expect(mocks.authorize).not.toHaveBeenCalled()
})

test('storageQuery keeps plain UUID buckets reachable when no package row exists', async () => {
	mocks.getSavedPackageById.mockResolvedValue(null)
	mocks.sqlQuery.mockResolvedValue({
		columns: ['ok'],
		rows: [{ ok: 1 }],
		rowCount: 1,
		rowsRead: 1,
		rowsWritten: 0,
		truncated: false,
	})

	await expect(
		storageQueryCapability.handler(
			{ storage_id: plainUuidBucket, query: 'SELECT 1 AS ok' },
			createContext() as never,
		),
	).resolves.toMatchObject({
		storage_id: plainUuidBucket,
		ok: true,
	})
	expect(mocks.sqlQuery).toHaveBeenCalled()
	expect(mocks.authorizePackageWrite).not.toHaveBeenCalled()
})
