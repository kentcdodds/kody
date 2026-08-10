import { beforeEach, expect, test, vi } from 'vitest'
import type * as IntegrationsService from '#worker/integrations/service.ts'

const createdAt = '1970-01-01T00:00:00.000Z'
const updatedAt = '1970-01-01T00:00:00.001Z'

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
	listJoinedIntegrations: vi.fn(async () => [
		{
			lane: 'user' as const,
			app: {
				userId: 'stable-user-1',
				slug: 'google',
				provider: 'google',
				label: null,
				clientId: 'shared-google-client',
				clientSecretSecretName: 'googleClientSecret',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce' as const,
				usePkce: null,
				tokenExchangeStyle: null,
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
				createdAt: '1970-01-01T00:00:00.000Z',
				updatedAt: '1970-01-01T00:00:00.001Z',
			},
			connection: {
				userId: 'stable-user-1',
				name: 'google',
				appSlug: 'google',
				platformAppSlug: null,
				accountLabel: 'Personal',
				description: '',
				scopes: ['openid', 'email'],
				requiredHosts: ['www.googleapis.com'],
				accessTokenSecretName: 'googleAccessToken',
				refreshTokenSecretName: 'googleRefreshToken',
				connectedAt: null,
				tokenRefreshedAt: null,
				createdAt: '1970-01-01T00:00:00.000Z',
				updatedAt: '1970-01-01T00:00:00.001Z',
			},
		},
		{
			lane: 'user' as const,
			app: {
				userId: 'stable-user-1',
				slug: 'google',
				provider: 'google',
				label: null,
				clientId: 'shared-google-client',
				clientSecretSecretName: 'googleClientSecret',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce' as const,
				usePkce: null,
				tokenExchangeStyle: null,
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
				createdAt: '1970-01-01T00:00:00.000Z',
				updatedAt: '1970-01-01T00:00:00.001Z',
			},
			connection: {
				userId: 'stable-user-1',
				name: 'google-calendar',
				appSlug: 'google',
				platformAppSlug: null,
				accountLabel: 'Work calendar',
				description: '',
				scopes: ['calendar.readonly'],
				requiredHosts: ['www.googleapis.com'],
				accessTokenSecretName: 'googleCalendarAccessToken',
				refreshTokenSecretName: 'googleCalendarRefreshToken',
				connectedAt: null,
				tokenRefreshedAt: null,
				createdAt: '1970-01-01T00:00:00.000Z',
				updatedAt: '1970-01-01T00:00:00.001Z',
			},
		},
		{
			lane: 'user' as const,
			app: {
				userId: 'stable-user-1',
				slug: 'github',
				provider: 'github',
				label: null,
				clientId: 'github-client-id-value',
				clientSecretSecretName: 'githubClientSecret',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				apiBaseUrl: 'https://api.github.com',
				flow: 'confidential' as const,
				usePkce: null,
				tokenExchangeStyle: null,
				scopeSeparator: null,
				extraAuthorizeParams: {},
				createdAt: '1970-01-01T00:00:00.000Z',
				updatedAt: '1970-01-01T00:00:00.001Z',
			},
			connection: {
				userId: 'stable-user-1',
				name: 'github',
				appSlug: 'github',
				platformAppSlug: null,
				accountLabel: null,
				description: '',
				scopes: ['repo', 'read:user'],
				requiredHosts: ['api.github.com'],
				accessTokenSecretName: 'githubAccessToken',
				refreshTokenSecretName: null,
				connectedAt: null,
				tokenRefreshedAt: null,
				createdAt: '1970-01-01T00:00:00.000Z',
				updatedAt: '1970-01-01T00:00:00.001Z',
			},
		},
	]),
	getJoinedIntegration: vi.fn(async () => ({
		lane: 'user' as const,
		app: {
			userId: 'stable-user-1',
			slug: 'github',
			provider: 'github',
			label: null,
			clientId: 'github-client-id-value',
			clientSecretSecretName: 'githubClientSecret',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential' as const,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
		},
		connection: {
			userId: 'stable-user-1',
			name: 'github',
			appSlug: 'github',
			platformAppSlug: null,
			accountLabel: null,
			description: '',
			scopes: ['repo', 'read:user'],
			requiredHosts: ['api.github.com'],
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: null,
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
		},
	})),
	findOauthAppForProviderSetup: vi.fn(async () => null),
	listOauthApps: vi.fn(async () => [
		{
			userId: 'stable-user-1',
			slug: 'github',
			provider: 'github',
			label: null,
			clientId: 'github-client-id-value',
			clientSecretSecretName: 'githubClientSecret',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential' as const,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			connectionCount: 1,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
		},
		{
			userId: 'stable-user-1',
			slug: 'google',
			provider: 'google',
			label: null,
			clientId: 'shared-google-client',
			clientSecretSecretName: 'googleClientSecret',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce' as const,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: { access_type: 'offline' },
			connectionCount: 2,
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
		},
	]),
	getOauthApp: vi.fn(async () => ({
		userId: 'stable-user-1',
		slug: 'google',
		provider: 'google',
		label: null,
		clientId: 'shared-google-client',
		clientSecretSecretName: 'googleClientSecret',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'pkce' as const,
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
		createdAt: '1970-01-01T00:00:00.000Z',
		updatedAt: '1970-01-01T00:00:00.001Z',
	})),
	rotateOauthAppClientCredentials: vi.fn(async () => ({
		userId: 'stable-user-1',
		slug: 'google',
		provider: 'google',
		label: null,
		clientId: 'shared-google-client-rotated',
		clientSecretSecretName: 'googleClientSecret',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'pkce' as const,
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
		createdAt: '1970-01-01T00:00:00.000Z',
		updatedAt: '1970-01-01T00:00:00.002Z',
	})),
	getAvailablePlatformApp: vi.fn(async () => null),
	listSecrets: vi.fn(async () => []),
	saveSecret: vi.fn(async () => ({
		name: 'googleClientSecret',
		scope: 'user' as const,
		description: 'google OAuth client secret',
		allowedHosts: ['oauth2.googleapis.com'],
		allowedCapabilities: [],
		allowedPackages: [],
		updatedAt: '1970-01-01T00:00:00.002Z',
	})),
	setSecretAllowedHosts: vi.fn(async () => undefined),
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

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listSecrets: (...args: Array<unknown>) => mockModule.listSecrets(...args),
	saveSecret: (...args: Array<unknown>) => mockModule.saveSecret(...args),
	setSecretAllowedHosts: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedHosts(...args),
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsService>()
	return {
		...actual,
		listJoinedIntegrations: (...args: Array<unknown>) =>
			mockModule.listJoinedIntegrations(...args),
		getJoinedIntegration: (...args: Array<unknown>) =>
			mockModule.getJoinedIntegration(...args),
		findOauthAppForProviderSetup: (...args: Array<unknown>) =>
			mockModule.findOauthAppForProviderSetup(...args),
		listOauthApps: (...args: Array<unknown>) =>
			mockModule.listOauthApps(...args),
		getOauthApp: (...args: Array<unknown>) => mockModule.getOauthApp(...args),
		rotateOauthAppClientCredentials: (...args: Array<unknown>) =>
			mockModule.rotateOauthAppClientCredentials(...args),
		getAvailablePlatformApp: (...args: Array<unknown>) =>
			mockModule.getAvailablePlatformApp(...args),
	}
})

const { createAccountIntegrationsApiHandler } =
	await import('./account-integrations.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
}

beforeEach(() => {
	vi.clearAllMocks()
})

test('integrations API lists connections with app grouping metadata and never exposes token values', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/integrations.json'),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.listJoinedIntegrations).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
	})
	expect(mockModule.listOauthApps).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
	})
	const payload = await response.json()
	expect(payload).toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		apps: [
			{
				slug: 'github',
				provider: 'github',
				label: null,
				clientId: 'github-client-id-value',
				clientSecretSecretName: 'githubClientSecret',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				apiBaseUrl: 'https://api.github.com',
				flow: 'confidential',
				usePkce: null,
				tokenExchangeStyle: null,
				scopeSeparator: null,
				extraAuthorizeParams: {},
				connectionCount: 1,
				connections: [{ name: 'github', accountLabel: null }],
				createdAt,
				updatedAt,
			},
			{
				slug: 'google',
				provider: 'google',
				label: null,
				clientId: 'shared-google-client',
				clientSecretSecretName: 'googleClientSecret',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce',
				usePkce: null,
				tokenExchangeStyle: null,
				scopeSeparator: null,
				extraAuthorizeParams: { access_type: 'offline' },
				connectionCount: 2,
				connections: [
					{ name: 'google', accountLabel: 'Personal' },
					{ name: 'google-calendar', accountLabel: 'Work calendar' },
				],
				createdAt,
				updatedAt,
			},
		],
		integrations: [
			{
				name: 'github',
				appSlug: 'github',
				provider: 'github',
				appLabel: null,
				accountLabel: null,
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'confidential',
				clientId: 'github-client-id-value',
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
			{
				name: 'google',
				appSlug: 'google',
				provider: 'google',
				appLabel: null,
				accountLabel: 'Personal',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce',
				clientId: 'shared-google-client',
				clientSecretSecretName: 'googleClientSecret',
				accessTokenSecretName: 'googleAccessToken',
				refreshTokenSecretName: 'googleRefreshToken',
				requiredHosts: ['www.googleapis.com'],
				authorization: {
					authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
					scopes: ['openid', 'email'],
					scopeSeparator: null,
					extraAuthorizeParams: { access_type: 'offline' },
				},
				createdAt,
				updatedAt,
			},
			{
				name: 'google-calendar',
				appSlug: 'google',
				provider: 'google',
				appLabel: null,
				accountLabel: 'Work calendar',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce',
				clientId: 'shared-google-client',
				clientSecretSecretName: 'googleClientSecret',
				accessTokenSecretName: 'googleCalendarAccessToken',
				refreshTokenSecretName: 'googleCalendarRefreshToken',
				requiredHosts: ['www.googleapis.com'],
				authorization: {
					authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
					scopes: ['calendar.readonly'],
					scopeSeparator: null,
					extraAuthorizeParams: { access_type: 'offline' },
				},
				createdAt,
				updatedAt,
			},
		],
	})
	// Secret *names* are fine in the payload; raw token values must never appear.
	expect(JSON.stringify(payload)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:/,
	)
	const googleConnections = payload.integrations.filter(
		(entry: { appSlug: string }) => entry.appSlug === 'google',
	)
	expect(googleConnections).toHaveLength(2)
	expect(
		new Set(
			googleConnections.map((entry: { clientId: string }) => entry.clientId),
		),
	).toEqual(new Set(['shared-google-client']))
})

test('integrations API returns one connection by name for the connect OAuth flow', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=GitHub',
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(mockModule.getJoinedIntegration).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'GitHub',
	})
	await expect(response.json()).resolves.toEqual({
		ok: true,
		builtInAvailable: false,
		existingConnection: { lane: 'user', appSlug: 'github' },
		integration: {
			name: 'github',
			appSlug: 'github',
			provider: 'github',
			appLabel: null,
			accountLabel: null,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientId: 'github-client-id-value',
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
	})
})

test('integrations API returns null when a named connection is missing', async () => {
	// Two reads: the record lookup and the existing-connection summary.
	mockModule.getJoinedIntegration.mockResolvedValueOnce(null)
	mockModule.getJoinedIntegration.mockResolvedValueOnce(null)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce(null)
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=missing',
		),
		params: {},
	} as never)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		builtInAvailable: false,
		existingConnection: null,
		integration: null,
	})
})

test('integrations API falls back to provider-setup app resolution so abandoned setup still returns the client id', async () => {
	mockModule.getJoinedIntegration.mockResolvedValueOnce(null)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce({
		userId: 'stable-user-1',
		slug: 'spotify',
		provider: 'spotify',
		label: null,
		clientId: 'spotify-client-from-setup',
		clientSecretSecretName: null,
		tokenUrl: 'https://accounts.spotify.com/api/token',
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		apiBaseUrl: null,
		flow: 'pkce' as const,
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: {},
		createdAt,
		updatedAt,
	})
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=spotify',
		),
		params: {},
	} as never)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		integration: {
			name: 'spotify',
			appSlug: 'spotify',
			clientId: 'spotify-client-from-setup',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: [],
			},
		},
	})
	expect(mockModule.findOauthAppForProviderSetup).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'spotify',
	})
})

test('integrations API prefills a shared family app when setting up google-calendar', async () => {
	mockModule.getJoinedIntegration.mockResolvedValueOnce(null)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce({
		userId: 'stable-user-1',
		slug: 'google',
		provider: 'google',
		label: null,
		clientId: 'shared-google-client',
		clientSecretSecretName: null,
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'pkce' as const,
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: { access_type: 'offline' },
		createdAt,
		updatedAt,
	})
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=google-calendar',
		),
		params: {},
	} as never)
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toMatchObject({
		ok: true,
		integration: {
			name: 'google-calendar',
			appSlug: 'google',
			clientId: 'shared-google-client',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			accessTokenSecretName: 'google-calendarAccessToken',
		},
	})
	expect(JSON.stringify(payload)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/,
	)
	expect(mockModule.findOauthAppForProviderSetup).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'google-calendar',
	})
})

test('integrations API rotates OAuth app credentials for the authenticated user', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'rotate_oauth_app_credentials',
				appSlug: 'google',
				clientId: 'shared-google-client-rotated',
				clientSecret: 'new-google-client-secret',
				confirm: true,
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(mockModule.getOauthApp).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		slug: 'google',
	})
	expect(mockModule.listSecrets).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		scope: 'user',
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
	expect(mockModule.saveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'googleClientSecret',
			value: 'new-google-client-secret',
			scope: 'user',
		}),
	)
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'googleClientSecret',
		scope: 'user',
		allowedHosts: [
			'accounts.google.com',
			'oauth2.googleapis.com',
			'www.googleapis.com',
		],
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
	expect(mockModule.rotateOauthAppClientCredentials).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		slug: 'google',
		clientId: 'shared-google-client-rotated',
		clientSecretSecretName: 'googleClientSecret',
	})
	const payload = await response.json()
	expect(payload).toMatchObject({
		ok: true,
		app: {
			slug: 'google',
			clientId: 'shared-google-client-rotated',
			clientSecretSecretName: 'googleClientSecret',
			connectionCount: 2,
			connections: [
				{ name: 'google', accountLabel: 'Personal' },
				{ name: 'google-calendar', accountLabel: 'Work calendar' },
			],
		},
	})
	expect(JSON.stringify(payload)).not.toMatch(
		/new-google-client-secret|"access_token"\s*:|"refresh_token"\s*:/,
	)
})

test('integrations API merge-keeps pre-existing client-secret allowed hosts on rotate', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'googleClientSecret',
			scope: 'user' as const,
			description: 'google OAuth client secret',
			packageId: null,
			allowedHosts: ['oauth2.googleapis.com', 'custom-package-api.example.com'],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: '1970-01-01T00:00:00.000Z',
			updatedAt: '1970-01-01T00:00:00.001Z',
			ttlMs: null,
		},
	])
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'rotate_oauth_app_credentials',
				appSlug: 'google',
				clientSecret: 'rotated-secret-value',
				confirm: true,
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'googleClientSecret',
		scope: 'user',
		allowedHosts: [
			'accounts.google.com',
			'custom-package-api.example.com',
			'oauth2.googleapis.com',
			'www.googleapis.com',
		],
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
	expect(JSON.stringify(await response.json())).not.toMatch(
		/rotated-secret-value/,
	)
})

test('integrations API returns 404 when rotating an unknown OAuth app slug', async () => {
	mockModule.getOauthApp.mockResolvedValueOnce(null)
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'rotate_oauth_app_credentials',
				appSlug: 'missing-app',
				clientSecret: 'secret-value',
				confirm: true,
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(404)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'OAuth app not found.',
	})
	expect(mockModule.rotateOauthAppClientCredentials).not.toHaveBeenCalled()
	expect(mockModule.saveSecret).not.toHaveBeenCalled()
})

test('integrations API rejects invalid rotate payloads', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'rotate_oauth_app_credentials',
				appSlug: 'google',
				confirm: false,
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid request body.',
	})
	expect(mockModule.getOauthApp).not.toHaveBeenCalled()
	expect(mockModule.rotateOauthAppClientCredentials).not.toHaveBeenCalled()
})

test('integrations API scopes rotate actions to the authenticated user', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const unauthorized = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'rotate_oauth_app_credentials',
				appSlug: 'google',
				clientSecret: 'secret-value',
				confirm: true,
			}),
		}),
		params: {},
	} as never)
	expect(unauthorized.status).toBe(401)
	expect(mockModule.rotateOauthAppClientCredentials).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		sessionUserId: '99',
		userId: 99,
		username: 'other-user',
		email: 'other@example.com',
		displayName: 'other',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-other',
			email: 'other@example.com',
			username: 'other-user',
			displayName: 'other',
		},
	})
	const handlerForOtherUser = createAccountIntegrationsApiHandler(createEnv())
	const response = await handlerForOtherUser.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'rotate_oauth_app_credentials',
				appSlug: 'google',
				clientId: 'other-client',
				clientSecret: 'other-secret',
				confirm: true,
			}),
		}),
		params: {},
	} as never)
	expect(response.status).toBe(200)
	expect(mockModule.getOauthApp).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-other',
		slug: 'google',
	})
	expect(mockModule.rotateOauthAppClientCredentials).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-other',
			slug: 'google',
		}),
	)
	expect(mockModule.saveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-other',
		}),
	)
})
