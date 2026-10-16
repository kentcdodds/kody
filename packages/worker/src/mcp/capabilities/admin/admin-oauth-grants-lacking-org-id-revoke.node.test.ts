import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { oauthGrantsLackingOrgIdRevokeConfirm } from '#worker/admin/oauth-grants-lacking-org-id.ts'
import { adminOauthGrantsLackingOrgIdRevokeCapability } from './admin-oauth-grants-lacking-org-id-revoke.ts'

const mocks = vi.hoisted(() => ({
	runOauthGrantsLackingOrgIdRevoke: vi.fn(),
}))

vi.mock(
	'#worker/admin/oauth-grants-lacking-org-id.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/admin/oauth-grants-lacking-org-id.ts')
			>()
		return {
			...actual,
			runOauthGrantsLackingOrgIdRevoke: mocks.runOauthGrantsLackingOrgIdRevoke,
		}
	},
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

test('admin oauth grants lacking orgId revoke enforces admin, dry-runs by default, and requires confirm to apply', async () => {
	await expect(
		adminOauthGrantsLackingOrgIdRevokeCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runOauthGrantsLackingOrgIdRevoke).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mocks.runOauthGrantsLackingOrgIdRevoke.mockResolvedValue({
		dryRun: true,
		scanned: 3,
		withOrgId: 1,
		lackingOrgId: 2,
		revoked: 0,
		usersLackingOrgId: 2,
		byClient: [{ clientId: 'client-cursor', count: 2 }],
		failures: [],
		nextCursor: null,
		complete: true,
	})

	const preview = await adminOauthGrantsLackingOrgIdRevokeCapability.handler(
		{},
		createContext(['admin']),
	)
	expect(mocks.runOauthGrantsLackingOrgIdRevoke).toHaveBeenCalledWith({
		env: expect.anything(),
		dryRun: true,
		cursor: null,
		limit: undefined,
	})
	expect(preview.lackingOrgId).toBe(2)
	expect(preview.revoked).toBe(0)

	await expect(
		adminOauthGrantsLackingOrgIdRevokeCapability.handler(
			{ dryRun: false },
			createContext(['admin']),
		),
	).rejects.toThrow(/confirm must be exactly/)

	mocks.runOauthGrantsLackingOrgIdRevoke.mockResolvedValue({
		dryRun: false,
		scanned: 3,
		withOrgId: 1,
		lackingOrgId: 2,
		revoked: 2,
		usersLackingOrgId: 2,
		byClient: [{ clientId: 'client-cursor', count: 2 }],
		failures: [],
		nextCursor: null,
		complete: true,
	})

	const applied = await adminOauthGrantsLackingOrgIdRevokeCapability.handler(
		{
			dryRun: false,
			confirm: oauthGrantsLackingOrgIdRevokeConfirm,
		},
		createContext(['admin']),
	)
	expect(mocks.runOauthGrantsLackingOrgIdRevoke).toHaveBeenLastCalledWith({
		env: expect.anything(),
		dryRun: false,
		cursor: null,
		limit: undefined,
	})
	expect(applied.revoked).toBe(2)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminOauthGrantsLackingOrgIdRevoke:success',
		'adminOauthGrantsLackingOrgIdRevoke:success',
	])
})
