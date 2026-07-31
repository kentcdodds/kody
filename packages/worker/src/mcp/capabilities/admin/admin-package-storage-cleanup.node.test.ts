import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	cleanupLegacyPackageStorageBuckets: vi.fn(),
}))

vi.mock('#worker/package-storage-audit/service.ts', () => ({
	defaultPackageStorageAuditLimit: 200,
	maxPackageStorageAuditLimit: 500,
	cleanupLegacyPackageStorageBuckets: mocks.cleanupLegacyPackageStorageBuckets,
}))

const { adminPackageStorageCleanupCapability } =
	await import('./admin-package-storage-cleanup.ts')

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'admin-user',
				username: 'admin',
				email: 'admin@example.com',
				roles,
			},
		}),
	}
}

test('admin package storage cleanup requires admin and reports cleared buckets', async () => {
	await expect(
		adminPackageStorageCleanupCapability.handler({}, createContext(['user'])),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.cleanupLegacyPackageStorageBuckets).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'mcp_capability_denied',
			result: 'failure',
		}),
	)

	const report = {
		ok: true as const,
		buckets: [{ userId: 'user-a', storageId: 'pkg-1', cleared: true }],
		nextStartAfter: null,
		totals: { cleared: 1, failed: 0, truncated: false },
	}
	mocks.cleanupLegacyPackageStorageBuckets.mockResolvedValue(report)
	const ctx = createContext(['admin'])

	await expect(
		adminPackageStorageCleanupCapability.handler({ limit: 25 }, ctx),
	).resolves.toEqual(report)
	expect(mocks.cleanupLegacyPackageStorageBuckets).toHaveBeenCalledWith({
		env: ctx.env,
		limit: 25,
		startAfter: undefined,
	})
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'admin_package_storage_cleanup:success',
	])
})
