import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	buildPackageStorageAuditReport: vi.fn(),
}))

vi.mock('#worker/package-storage-audit/service.ts', () => ({
	defaultPackageStorageAuditLimit: 200,
	maxPackageStorageAuditLimit: 500,
	buildPackageStorageAuditReport: mocks.buildPackageStorageAuditReport,
}))

const { adminPackageStorageAuditCapability } =
	await import('./admin-package-storage-audit.ts')

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

const emptyReport = {
	ok: true as const,
	packages: [],
	orphanAppBuckets: [],
	nextStartAfter: null as string | null,
	totals: {
		appPackages: 0,
		nonEmptyLegacyBuckets: 0,
		packagesWithAmbientImports: 0,
		orphanAppBuckets: 0,
		truncated: false,
		orphanTruncated: false,
	},
}

test('admin package storage audit requires admin and returns the platform-wide report', async () => {
	await expect(
		adminPackageStorageAuditCapability.handler({}, createContext(['user'])),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.buildPackageStorageAuditReport).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	const nextStartAfter = JSON.stringify({
		userId: 'user-a',
		packageId: 'pkg-1',
	})
	mocks.buildPackageStorageAuditReport.mockResolvedValue({
		...emptyReport,
		packages: [
			{
				userId: 'user-a',
				packageId: 'pkg-1',
				kodyId: 'demo',
				legacyBucketBytes: 8192,
				legacyBucketProbeError: null,
				ambientStorageImportFiles: ['app.ts'],
				sourceScanError: null,
			},
		],
		nextStartAfter,
		totals: {
			...emptyReport.totals,
			appPackages: 1,
			nonEmptyLegacyBuckets: 1,
			packagesWithAmbientImports: 1,
			truncated: true,
		},
	})

	const ctx = createContext(['admin'])
	const cursor = JSON.stringify({ userId: 'user-a', packageId: 'pkg-0' })
	const result = await adminPackageStorageAuditCapability.handler(
		{ limit: 25, start_after: cursor },
		ctx,
	)

	expect(mocks.buildPackageStorageAuditReport).toHaveBeenCalledWith({
		env: ctx.env,
		baseUrl: 'https://heykody.dev',
		limit: 25,
		startAfter: cursor,
	})
	expect(result).toMatchObject({
		ok: true,
		nextStartAfter,
		packages: [
			expect.objectContaining({
				packageId: 'pkg-1',
				ambientStorageImportFiles: ['app.ts'],
			}),
		],
		totals: {
			appPackages: 1,
			nonEmptyLegacyBuckets: 1,
			packagesWithAmbientImports: 1,
			truncated: true,
		},
	})
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'admin_package_storage_audit:success',
	])
})

test('admin package storage audit defaults limit and rejects values above max', async () => {
	mocks.buildPackageStorageAuditReport.mockResolvedValue(emptyReport)
	const ctx = createContext(['admin'])

	await adminPackageStorageAuditCapability.handler({}, ctx)
	expect(mocks.buildPackageStorageAuditReport).toHaveBeenLastCalledWith(
		expect.objectContaining({ limit: 200, startAfter: undefined }),
	)

	await expect(
		adminPackageStorageAuditCapability.handler({ limit: 501 }, ctx),
	).rejects.toThrow()
	expect(mocks.buildPackageStorageAuditReport).toHaveBeenCalledTimes(1)

	await adminPackageStorageAuditCapability.handler({ limit: 500 }, ctx)
	expect(mocks.buildPackageStorageAuditReport).toHaveBeenLastCalledWith(
		expect.objectContaining({ limit: 500 }),
	)
})
