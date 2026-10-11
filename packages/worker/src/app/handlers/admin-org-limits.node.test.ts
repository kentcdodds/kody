import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

const { createAdminOrgLimitsApiHandler } = await import('./admin-org-limits.ts')

const orgId = 'a'.repeat(64)

function createActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'member@example.com',
		username: 'member',
		displayName: 'member',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: 'b'.repeat(64),
			email: 'member@example.com',
			username: 'member',
			displayName: 'member',
		},
	}
}

function createClient() {
	const queries: Array<string> = []
	const env = {
		APP_DB: {
			prepare(query: string) {
				queries.push(query)
				throw new Error(`Unexpected query: ${query}`)
			},
		},
	} as unknown as Env
	const { handler } = createAdminOrgLimitsApiHandler(env)
	const url = `https://example.com/admin/orgs/limits.json?orgId=${orgId}`
	const send = (body?: unknown) =>
		handler({
			request: new Request(url, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					Accept: 'application/json',
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
			params: {},
			url: new URL(url),
		} as never)
	return { send, queries }
}

test('admin org limits HTTP API denies non-admins before touching D1', async () => {
	const { send, queries } = createClient()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['user']))

	expect((await send()).status).toBe(403)
	expect(
		(
			await send({
				orgId,
				changes: [{ key: 'outbound_fetches_per_day', value: 'unlimited' }],
				reason: 'not an admin',
			})
		).status,
	).toBe(403)
	expect(queries).toEqual([])
})
