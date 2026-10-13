import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { adminPublishedSourceSnapshotBackfillCapability } from './admin-published-source-snapshot-backfill.ts'

const mocks = vi.hoisted(() => ({
	runPublishedSourceSnapshotBackfill: vi.fn(),
}))

vi.mock(
	'#worker/package-runtime/published-source-snapshot-backfill.ts',
	() => ({
		publishedSourceSnapshotBackfillApplyLimitDefault: 5,
		publishedSourceSnapshotBackfillApplyLimitMax: 10,
		publishedSourceSnapshotBackfillScanLimitDefault: 50,
		publishedSourceSnapshotBackfillScanLimitMax: 200,
		runPublishedSourceSnapshotBackfill: (...args: Array<unknown>) =>
			mocks.runPublishedSourceSnapshotBackfill(...args),
	}),
)

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('actor-1'),
				username: 'actor',
				email: 'actor@example.com',
				displayName: 'Actor',
				roles,
			},
		}),
	}
}

test('admin published source snapshot backfill enforces admin and defaults to dry-run', async () => {
	await expect(
		adminPublishedSourceSnapshotBackfillCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runPublishedSourceSnapshotBackfill).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mocks.runPublishedSourceSnapshotBackfill.mockResolvedValue({
		dryRun: true,
		scannedPackages: 2,
		publishedPackages: 2,
		packagesNeedingRebuild: 1,
		rebuiltPackages: 0,
		failedPackages: 0,
		alreadyPresentPackages: 1,
		skippedUnpublished: 0,
		nextCursor: null,
		outcomes: [],
	})

	const result = await adminPublishedSourceSnapshotBackfillCapability.handler(
		{},
		createContext(['admin']),
	)

	expect(mocks.runPublishedSourceSnapshotBackfill).toHaveBeenCalledWith({
		env: expect.anything(),
		dryRun: true,
		afterId: null,
		limit: undefined,
		packageIds: undefined,
		ownerUserIds: undefined,
		sourceIds: undefined,
	})
	expect(result.packagesNeedingRebuild).toBe(1)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminPublishedSourceSnapshotBackfill:success',
	])
})
