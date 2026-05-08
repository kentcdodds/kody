import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	})),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	listRemoteConnectorSettings: vi.fn(async () => [
		{
			id: 'connector-1',
			kind: 'lights',
			instanceId: 'default',
			enabled: true,
			attached: true,
			hasSharedSecret: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
	saveRemoteConnectorSetting: vi.fn(async () => ({
		id: 'connector-1',
		kind: 'lights',
		instanceId: 'default',
		enabled: true,
		attached: true,
		hasSharedSecret: true,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	deleteRemoteConnectorSetting: vi.fn(async () => true),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: (...args: Array<unknown>) =>
		mockModule.readAuthSessionResult(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/layout.ts', () => ({
	Layout: () => null,
}))

vi.mock('#app/render.ts', () => ({
	render: () => new Response('ok'),
}))

vi.mock('#worker/remote-connector/settings-service.ts', () => ({
	listRemoteConnectorSettings: (...args: Array<unknown>) =>
		mockModule.listRemoteConnectorSettings(...args),
	saveRemoteConnectorSetting: (...args: Array<unknown>) =>
		mockModule.saveRemoteConnectorSetting(...args),
	deleteRemoteConnectorSetting: (...args: Array<unknown>) =>
		mockModule.deleteRemoteConnectorSetting(...args),
}))

const { createAccountRemoteConnectorsApiHandler } =
	await import('./account-remote-connectors.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
}

test('remote connector settings API lists metadata without plaintext secrets', async () => {
	const handler = createAccountRemoteConnectorsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/remote-connectors.json'),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	const text = await response.text()
	expect(text).toContain('"hasSharedSecret":true')
	expect(text).not.toContain('lights-secret')
	expect(JSON.parse(text)).toEqual({
		ok: true,
		email: 'user@example.com',
		connectors: [
			{
				id: 'connector-1',
				kind: 'lights',
				instanceId: 'default',
				enabled: true,
				attached: true,
				hasSharedSecret: true,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		],
	})
})

test('remote connector settings API passes shared secret only to save service', async () => {
	const handler = createAccountRemoteConnectorsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/remote-connectors.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save',
				kind: 'roku',
				instanceId: 'living-room',
				enabled: true,
				attached: true,
				sharedSecret: 'roku-secret',
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(mockModule.saveRemoteConnectorSetting).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			kind: 'roku',
			instanceId: 'living-room',
			sharedSecret: 'roku-secret',
		}),
	)
	expect(await response.text()).not.toContain('roku-secret')
})
