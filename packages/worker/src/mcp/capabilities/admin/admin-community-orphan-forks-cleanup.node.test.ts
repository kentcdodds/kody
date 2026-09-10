import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { adminCommunityOrphanForksCleanupCapability } from './admin-community-orphan-forks-cleanup.ts'

const mocks = vi.hoisted(() => ({
	cleanupOrphanedCommunityForks: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	cleanupOrphanedCommunityForks: mocks.cleanupOrphanedCommunityForks,
}))

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'actor-1',
				username: 'actor',
				email: 'actor@example.com',
				roles,
			},
		}),
	}
}

test('admin orphan fork cleanup enforces admin role, previews by default, and applies only when asked', async () => {
	await expect(
		adminCommunityOrphanForksCleanupCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.cleanupOrphanedCommunityForks).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mocks.cleanupOrphanedCommunityForks.mockResolvedValue({
		applied: true,
		deletedCount: 1,
		orphans: [
			{
				forkId: 'fork-orphan',
				listingId: 'listing-1',
				listingName: '@kody/plaid',
				listingKodyId: 'plaid',
				forkerUserId: 'user-kent',
				forkedPackageId: 'package-missing',
				forkedSourceId: 'source-missing',
				targetKodyId: 'plaid-fork-test-cleanup',
				createdAt: '2026-09-10T00:00:00.000Z',
			},
		],
	})

	const result = await adminCommunityOrphanForksCleanupCapability.handler(
		{
			apply: true,
			fork_ids: ['fork-orphan'],
		},
		createContext(['admin']),
	)

	expect(mocks.cleanupOrphanedCommunityForks).toHaveBeenCalledWith({
		env: expect.anything(),
		apply: true,
		forkIds: ['fork-orphan'],
	})
	expect(result).toEqual({
		applied: true,
		deleted_count: 1,
		orphans: [
			{
				fork_id: 'fork-orphan',
				listing_id: 'listing-1',
				listing_name: '@kody/plaid',
				listing_kody_id: 'plaid',
				forker_user_id: 'user-kent',
				forked_package_id: 'package-missing',
				forked_source_id: 'source-missing',
				target_kody_id: 'plaid-fork-test-cleanup',
				created_at: '2026-09-10T00:00:00.000Z',
			},
		],
	})
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminCommunityOrphanForksCleanup:success',
	])
})
