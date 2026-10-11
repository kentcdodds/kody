import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { adminOrgResourceTransferCapability } from './admin-org-resource-transfer.ts'

const mocks = vi.hoisted(() => ({ runOrgResourceTransfer: vi.fn() }))

vi.mock('#worker/org-transfer/apply.ts', () => ({
	runOrgResourceTransfer: mocks.runOrgResourceTransfer,
}))

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

const summary = {
	from: { id: 'org-a', slug: 'bradhave' },
	to: { id: 'org-b', slug: 'haveman' },
	counts: { saved_packages: 1 },
	packages: [{ id: 'p1', from_name: '@bradhave/x', to_name: '@haveman/x' }],
	repos: [],
	secrets: [{ scope: 'user', binding: '', name: 'API_KEY' }],
	values: [],
	integrations: [],
	oauth_apps: [],
	mcp_servers: [],
	webhooks: [],
	jobs: [],
	storages: [],
	orphans: [],
	clashes: [],
	blockers: [],
	warnings: [],
}

test('adminOrgResourceTransfer is admin-only, destructive, and audited', async () => {
	expect(adminOrgResourceTransferCapability.destructive).toBe(true)
	await expect(
		adminOrgResourceTransferCapability.handler(
			{ fromOrgId: 'org-a', toOrgId: 'org-b', mode: 'apply' },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runOrgResourceTransfer).not.toHaveBeenCalled()

	mocks.runOrgResourceTransfer.mockResolvedValue({
		mode: 'apply',
		applied: true,
		summary,
		backupKey: 'org-resource-transfers/org-a/org-b/x.json',
		storage: [{ storageId: 'package:p1', kvEntries: 1, sqlRows: {} }],
		leftovers: {},
		postCommitWarnings: [],
	})
	const result = await adminOrgResourceTransferCapability.handler(
		{ fromOrgId: 'org-a', toOrgId: 'org-b', mode: 'apply', skipOrphans: true },
		createContext(['admin']),
	)
	expect(mocks.runOrgResourceTransfer).toHaveBeenCalledWith(
		expect.objectContaining({
			fromOrgId: 'org-a',
			toOrgId: 'org-b',
			mode: 'apply',
			skipOrphans: true,
			actorUserId: 'actor-1',
		}),
	)
	expect(result).toMatchObject({
		applied: true,
		backup_key: 'org-resource-transfers/org-a/org-b/x.json',
		packages: summary.packages,
		storage_copies: [{ storage_id: 'package:p1', kv_entries: 1, sql_rows: {} }],
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminOrgResourceTransfer',
			result: 'success',
			reason: expect.stringContaining('backup=org-resource-transfers/'),
		}),
	)
})
