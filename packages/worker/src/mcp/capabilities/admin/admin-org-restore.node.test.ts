import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mocks = vi.hoisted(() => ({
	restoreOrg: vi.fn(),
	logAuditEvent: vi.fn<typeof AuditLog.logAuditEvent>(async () => ({
		persisted: false,
		failedSinks: [],
	})),
}))

vi.mock('#worker/orgs/soft-delete.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/soft-delete.ts')>()
	return {
		...actual,
		restoreOrg: mocks.restoreOrg,
	}
})

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: mocks.logAuditEvent,
	}
})

const { adminOrgRestoreCapability } = await import('./admin-org-restore.ts')

const orgId = testStableUserIdFromEmail('admin-restore-org@example.com')
const reason = 'Support recovery for a soft-deleted team organization.'

test('adminOrgRestore is admin-only and destructive', () => {
	expect(adminOrgRestoreCapability.requiredRole).toBe('admin')
	expect(adminOrgRestoreCapability.destructive).toBe(true)
	expect(adminOrgRestoreCapability.orgPermission).toBe('none')
})

test('adminOrgRestore calls restoreOrg for a soft-deleted team org', async () => {
	const first = vi.fn()
	first
		.mockResolvedValueOnce({
			slug: 'admin-restore-co',
			deleted_at: '2026-10-10T00:00:00.000Z',
		})
		.mockResolvedValueOnce(null)
	const prepare = vi.fn(() => ({
		bind: vi.fn(() => ({ first })),
	}))
	mocks.restoreOrg.mockResolvedValue({
		orgId: ownerIdFromStored(orgId),
		restoredAt: '2026-10-17T00:00:00.000Z',
		resourceRowsRestored: 0,
		jobsRestored: 0,
	})
	const result = await adminOrgRestoreCapability.handler(
		{ org_id: orgId, reason },
		{
			env: { APP_DB: { prepare } } as unknown as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(
						testStableUserIdFromEmail('admin@example.com'),
					),
					email: 'admin@example.com',
					displayName: 'Admin',
					roles: ['admin'],
				},
			}),
		} as never,
	)
	expect(result).toEqual({
		orgId: ownerIdFromStored(orgId),
		slug: 'admin-restore-co',
		restoredAt: '2026-10-17T00:00:00.000Z',
	})
	expect(mocks.restoreOrg).toHaveBeenCalledWith(
		expect.objectContaining({ orgId: ownerIdFromStored(orgId) }),
	)
})
