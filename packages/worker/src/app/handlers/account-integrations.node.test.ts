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
	listValues: vi.fn(async () => [
		{
			name: '_integration:github',
			scope: 'user',
			value: JSON.stringify({
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'confidential',
				clientIdValueName: 'github-client-id',
				clientSecretSecretName: 'githubClientSecret',
				accessTokenSecretName: 'githubAccessToken',
				refreshTokenSecretName: null,
				requiredHosts: ['api.github.com'],
				authorization: {
					authorizeUrl: 'https://github.com/login/oauth/authorize',
					scopes: ['repo', 'read:user'],
				},
			}),
			description: '',
			appId: null,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
			ttlMs: null,
		},
		{
			name: '_integration:broken',
			scope: 'user',
			value: '{',
			description: '',
			appId: null,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
			ttlMs: null,
		},
		{
			name: 'plain-value',
			scope: 'user',
			value: 'ignored',
			description: '',
			appId: null,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
			ttlMs: null,
		},
	]),
}))

const createdAt = '1970-01-01T00:00:00.000Z'
const updatedAt = '1970-01-01T00:00:00.001Z'

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

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
}))

const { createAccountIntegrationsApiHandler } =
	await import('./account-integrations.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
}

test('integrations API lists valid user-scoped OAuth integrations and skips malformed values', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/integrations.json'),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.listValues).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		scope: 'user',
		storageContext: { sessionId: null, appId: null },
	})
	await expect(response.json()).resolves.toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		integrations: [
			{
				name: 'github',
				valueName: '_integration:github',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'confidential',
				clientIdValueName: 'github-client-id',
				clientSecretSecretName: 'githubClientSecret',
				accessTokenSecretName: 'githubAccessToken',
				refreshTokenSecretName: null,
				requiredHosts: ['api.github.com'],
				authorization: {
					authorizeUrl: 'https://github.com/login/oauth/authorize',
					scopes: ['repo', 'read:user'],
					scopeSeparator: null,
					extraAuthorizeParams: {},
				},
				createdAt,
				updatedAt,
			},
		],
	})
})
