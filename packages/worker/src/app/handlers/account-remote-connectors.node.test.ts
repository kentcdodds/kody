import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	listRemoteConnectorSettingsWithSharedSecrets: vi.fn(async () => [
		{
			id: 'connector-1',
			kind: 'lights',
			instanceId: 'default',
			enabled: true,
			attached: true,
			hasSharedSecret: true,
			sharedSecret: 'lights-secret',
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
	listRemoteConnectorSettingsWithSharedSecrets: (...args: Array<unknown>) =>
		mockModule.listRemoteConnectorSettingsWithSharedSecrets(...args),
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

test('remote connector settings API lists settings with plaintext secrets', async () => {
	const handler = createAccountRemoteConnectorsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/remote-connectors.json'),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	await expect(response.json()).resolves.toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		connectorUrlOrigin: 'wss://example.com',
		connectors: [
			{
				id: 'connector-1',
				kind: 'lights',
				instanceId: 'default',
				connectorUrl: 'wss://example.com/@test-user/connectors/lights/default',
				enabled: true,
				attached: true,
				hasSharedSecret: true,
				sharedSecret: 'lights-secret',
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		],
	})
})

test('remote connector settings API passes submitted secret to save service', async () => {
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
	expect(await response.json()).toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		connectorUrlOrigin: 'wss://example.com',
		selectedConnectorId: 'connector-1',
		connectors: [
			{
				id: 'connector-1',
				kind: 'lights',
				instanceId: 'default',
				connectorUrl: 'wss://example.com/@test-user/connectors/lights/default',
				enabled: true,
				attached: true,
				hasSharedSecret: true,
				sharedSecret: 'lights-secret',
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		],
	})
})
