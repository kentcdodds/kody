import { expect, test, vi } from 'vitest'
import { inviteAssignablePlanNames } from '#worker/entitlements/plans.ts'
import type * as AuditLog from '#app/audit-log.ts'
import type * as Invites from '#app/invites.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import { createAdminInvitesApiHandler } from './admin-invites.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	createInvite: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/invites.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof Invites>()
	return {
		...actual,
		createInvite: (...args: Array<unknown>) => mockModule.createInvite(...args),
	}
})

vi.mock('#app/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: 'stable-admin',
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createInvitesEnv() {
	return {
		COOKIE_SECRET: 'secret',
		APP_DB: {
			prepare() {
				return {
					async all() {
						return { results: [] }
					},
				}
			},
		},
	} as unknown as Env
}

test('admin invites API lists invite-assignable plans only', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminInvitesApiHandler(createInvitesEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/admin/invites.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/invites.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.availablePlans).toEqual([...inviteAssignablePlanNames])
	expect(payload.availablePlans).toHaveLength(4)
	expect(payload.availablePlans).not.toContain('unlimited')
})

test('admin invites create rejects unlimited plan', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	mockModule.createInvite.mockReset()
	const handler = createAdminInvitesApiHandler(createInvitesEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/admin/invites.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'create_invite',
				code: 'NO-UNLIMITED',
				plan: 'unlimited',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/invites.json'),
	} as never)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload.ok).toBe(false)
	expect(payload.error).toMatch(/Unlimited is not invite-assignable/i)
	expect(mockModule.createInvite).not.toHaveBeenCalled()
})
