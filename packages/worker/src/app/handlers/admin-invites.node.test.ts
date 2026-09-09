import { expect, test, vi } from 'vitest'
import { type AdminInvitesLoaderData } from '#universal/loader-data.ts'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	loadAdminInvitesData: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#app/admin-invites-data.ts', () => ({
	loadAdminInvitesData: (...args: Array<unknown>) =>
		mockModule.loadAdminInvitesData(...args),
}))

const { createAdminInvitesApiHandler } = await import('./admin-invites.ts')

function loaderPayload(): AdminInvitesLoaderData {
	return {
		ok: true,
		invites: [],
		availablePlans: ['free'],
	}
}

function postRequest(body: Record<string, unknown>) {
	return new Request('https://example.com/admin/invites.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

test('unknown admin invite actions are refused', async () => {
	mockModule.requireUserWithRole.mockResolvedValue({
		email: 'admin@example.com',
		mcpUser: { userId: 'admin-stable-id' },
	})
	mockModule.loadAdminInvitesData.mockResolvedValue(loaderPayload())

	const env = {
		APP_DB: {} as D1Database,
	} as unknown as Env
	const handler = createAdminInvitesApiHandler(env)
	const url = new URL('https://example.com/admin/invites.json')

	const response = await handler.handler({
		request: postRequest({ action: 'not_a_real_action' }),
		params: {},
		url,
	} as never)
	expect(response.status).toBe(400)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Invalid action.',
	})
})
