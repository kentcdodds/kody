import { expect, test, vi } from 'vitest'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import type * as IntegrationsRepo from '#worker/integrations/repo.ts'
import type * as IntegrationsCredentials from '#worker/integrations/credentials.ts'
import type * as PackageRegistryRepo from '#worker/package-registry/repo.ts'

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
				usageMode: 'any',
				allowedPackageIds: [],
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
	listAvailablePlatformApps: vi.fn(async () => []),
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
	deleteIntegration: vi.fn(async () => true),
	deleteOauthAppWithConnections: vi.fn(async () => ({
		deleted: true,
		connectionNames: ['google', 'google-calendar'],
	})),
	listSavedPackagesByUserId: vi.fn(async () => []),
	getOauthAppClientSecretCiphertext: vi.fn(async () => null),
	persistUserOauthAppClientSecret: vi.fn(async () => undefined),
	setIntegrationUsage: vi.fn(async () => ({
		name: 'google',
		usageMode: 'packages' as const,
		allowedPackageIds: ['pkg-mail'],
	})),
	grantIntegrationPackage: vi.fn(async () => ({
		name: 'google',
		usageMode: 'packages' as const,
		allowedPackageIds: ['pkg-mail'],
	})),
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
		deleteIntegration: (...args: Array<unknown>) =>
			mockModule.deleteIntegration(...args),
		deleteOauthAppWithConnections: (...args: Array<unknown>) =>
			mockModule.deleteOauthAppWithConnections(...args),
		getAvailablePlatformApp: (...args: Array<unknown>) =>
			mockModule.getAvailablePlatformApp(...args),
		listAvailablePlatformApps: (...args: Array<unknown>) =>
			mockModule.listAvailablePlatformApps(...args),
		setIntegrationUsage: (...args: Array<unknown>) =>
			mockModule.setIntegrationUsage(...args),
		grantIntegrationPackage: (...args: Array<unknown>) =>
			mockModule.grantIntegrationPackage(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageRegistryRepo>()
	return {
		...actual,
		listSavedPackagesByUserId: (...args: Array<unknown>) =>
			mockModule.listSavedPackagesByUserId(...args),
	}
})

vi.mock('#worker/integrations/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsRepo>()
	return {
		...actual,
		getOauthAppClientSecretCiphertext: (...args: Array<unknown>) =>
			mockModule.getOauthAppClientSecretCiphertext(...args),
	}
})

vi.mock('#worker/integrations/credentials.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsCredentials>()
	return {
		...actual,
		persistUserOauthAppClientSecret: (...args: Array<unknown>) =>
			mockModule.persistUserOauthAppClientSecret(...args),
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

test('integrations API lists connections with app grouping metadata and serves the connect-oauth chooser without token values', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/integrations.json'),
		params: {},
	} as never)

	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.listJoinedIntegrations).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
	})
	expect(mockModule.listOauthApps).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
	})
	const listPayload = await listResponse.json()
	expect(listPayload).toMatchObject({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		savedPackages: [],
		approval: null,
	})
	expect(listPayload.apps).toHaveLength(2)
	expect(listPayload.apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				slug: 'github',
				clientId: 'github-client-id-value',
				connectionCount: 1,
				connections: [{ name: 'github', accountLabel: null }],
			}),
			expect.objectContaining({
				slug: 'google',
				clientId: 'shared-google-client',
				connectionCount: 2,
				connections: [
					{ name: 'google', accountLabel: 'Personal' },
					{ name: 'google-calendar', accountLabel: 'Work calendar' },
				],
			}),
		]),
	)
	expect(listPayload.integrations).toHaveLength(3)
	expect(listPayload.integrations).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'github',
				appSlug: 'github',
				clientId: 'github-client-id-value',
			}),
			expect.objectContaining({
				name: 'google',
				appSlug: 'google',
				clientId: 'shared-google-client',
				usageMode: 'any',
			}),
			expect.objectContaining({
				name: 'google-calendar',
				appSlug: 'google',
				clientId: 'shared-google-client',
			}),
		]),
	)
	// Secret *names* are fine in the payload; raw token values must never appear.
	expect(JSON.stringify(listPayload)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:/,
	)
	const googleConnections = listPayload.integrations.filter(
		(entry: { appSlug: string }) => entry.appSlug === 'google',
	)
	expect(googleConnections).toHaveLength(2)
	expect(
		new Set(
			googleConnections.map((entry: { clientId: string }) => entry.clientId),
		),
	).toEqual(new Set(['shared-google-client']))

	const chooserResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?connectChooser=1',
		),
		params: {},
	} as never)
	expect(chooserResponse.status).toBe(200)
	const chooserPayload = await chooserResponse.json()
	expect(chooserPayload.ok).toBe(true)
	expect(chooserPayload.chooser.options).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'connection:google',
				kind: 'connection',
				href: '/connect/oauth?provider=google&app=google',
			}),
		]),
	)
	expect(JSON.stringify(chooserPayload)).not.toMatch(
		/secret-value|token-value/i,
	)
})

test('integrations API resolves named connections for connect OAuth, including missing and abandoned setup', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())

	const githubResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=GitHub',
		),
		params: {},
	} as never)
	expect(githubResponse.status).toBe(200)
	expect(mockModule.getJoinedIntegration).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'GitHub',
	})
	await expect(githubResponse.json()).resolves.toMatchObject({
		ok: true,
		builtInAvailable: false,
		existingConnection: { lane: 'user', appSlug: 'github' },
		hasStoredClientSecret: false,
		integration: {
			name: 'github',
			appSlug: 'github',
			clientId: 'github-client-id-value',
		},
	})

	mockModule.getJoinedIntegration.mockResolvedValueOnce(null)
	mockModule.getJoinedIntegration.mockResolvedValueOnce(null)
	mockModule.findOauthAppForProviderSetup.mockResolvedValueOnce(null)
	const missingResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=missing',
		),
		params: {},
	} as never)
	expect(missingResponse.status).toBe(200)
	await expect(missingResponse.json()).resolves.toEqual({
		ok: true,
		builtInAvailable: false,
		existingConnection: null,
		hasStoredClientSecret: false,
		integration: null,
	})

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
	const abandonedResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=spotify',
		),
		params: {},
	} as never)
	expect(abandonedResponse.status).toBe(200)
	await expect(abandonedResponse.json()).resolves.toMatchObject({
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
	const familyResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=google-calendar',
		),
		params: {},
	} as never)
	expect(familyResponse.status).toBe(200)
	const familyPayload = await familyResponse.json()
	expect(familyPayload).toMatchObject({
		ok: true,
		integration: {
			name: 'google-calendar',
			appSlug: 'google',
			clientId: 'shared-google-client',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			accessTokenSecretName: 'google-calendarAccessToken',
		},
	})
	expect(JSON.stringify(familyPayload)).not.toMatch(
		/"access_token"\s*:|"refresh_token"\s*:|sk_|secret_value/,
	)
	expect(mockModule.findOauthAppForProviderSetup).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'google-calendar',
	})
})

test('integrations API rotates OAuth app credentials with auth scoping and validation', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())

	const rotateResponse = await handler.handler({
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
	expect(rotateResponse.status).toBe(200)
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
		includeIntegrationOwned: true,
	})
	expect(mockModule.persistUserOauthAppClientSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			slug: 'google',
			value: 'new-google-client-secret',
			secretName: 'googleClientSecret',
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
	const rotatePayload = await rotateResponse.json()
	expect(rotatePayload).toMatchObject({
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
	expect(JSON.stringify(rotatePayload)).not.toMatch(
		/new-google-client-secret|"access_token"\s*:|"refresh_token"\s*:/,
	)

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
			expiresAt: null,
			ttlMs: null,
		},
	])
	const mergeResponse = await handler.handler({
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
	expect(mergeResponse.status).toBe(200)
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
	expect(JSON.stringify(await mergeResponse.json())).not.toMatch(
		/rotated-secret-value/,
	)

	mockModule.getOauthApp.mockResolvedValueOnce(null)
	const rotateCallsBeforeMissingApp =
		mockModule.rotateOauthAppClientCredentials.mock.calls.length
	const saveSecretCallsBeforeMissingApp =
		mockModule.saveSecret.mock.calls.length
	const missingAppResponse = await handler.handler({
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
	expect(missingAppResponse.status).toBe(404)
	await expect(missingAppResponse.json()).resolves.toEqual({
		ok: false,
		error: 'OAuth app not found.',
	})
	expect(mockModule.rotateOauthAppClientCredentials.mock.calls.length).toBe(
		rotateCallsBeforeMissingApp,
	)
	expect(mockModule.saveSecret.mock.calls.length).toBe(
		saveSecretCallsBeforeMissingApp,
	)

	const getOauthAppCallsBeforeInvalid = mockModule.getOauthApp.mock.calls.length
	const rotateCallsBeforeInvalid =
		mockModule.rotateOauthAppClientCredentials.mock.calls.length
	const invalidResponse = await handler.handler({
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
	expect(invalidResponse.status).toBe(400)
	await expect(invalidResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid request body.',
	})
	expect(mockModule.getOauthApp.mock.calls.length).toBe(
		getOauthAppCallsBeforeInvalid,
	)
	expect(mockModule.rotateOauthAppClientCredentials.mock.calls.length).toBe(
		rotateCallsBeforeInvalid,
	)

	const rotateCallsBeforeUnauthorized =
		mockModule.rotateOauthAppClientCredentials.mock.calls.length
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const unauthorizedResponse = await handler.handler({
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
	expect(unauthorizedResponse.status).toBe(401)
	expect(mockModule.rotateOauthAppClientCredentials.mock.calls.length).toBe(
		rotateCallsBeforeUnauthorized,
	)

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
	const otherUserResponse = await handler.handler({
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
	expect(otherUserResponse.status).toBe(200)
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
	expect(mockModule.persistUserOauthAppClientSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-other',
		}),
	)
})

test('integrations API disconnects a connection and deletes a user-lane OAuth app', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	const disconnectResponse = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'disconnect_connection',
				name: 'google-calendar',
			}),
		}),
		params: {},
	} as never)
	expect(disconnectResponse.status).toBe(200)
	await expect(disconnectResponse.json()).resolves.toEqual({
		ok: true,
		deleted: true,
	})
	expect(mockModule.deleteIntegration).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'google-calendar',
	})

	mockModule.deleteIntegration.mockResolvedValueOnce(false)
	const missingDisconnect = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'disconnect_connection',
				name: 'missing',
			}),
		}),
		params: {},
	} as never)
	expect(missingDisconnect.status).toBe(404)

	const deleteAppResponse = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete_oauth_app',
				appSlug: 'google',
			}),
		}),
		params: {},
	} as never)
	expect(deleteAppResponse.status).toBe(200)
	await expect(deleteAppResponse.json()).resolves.toEqual({
		ok: true,
		deleted: true,
		connectionNames: ['google', 'google-calendar'],
	})
	expect(mockModule.getOauthApp).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		slug: 'google',
	})
	expect(mockModule.deleteOauthAppWithConnections).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		slug: 'google',
	})

	mockModule.getOauthApp.mockResolvedValueOnce(null)
	const missingApp = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete_oauth_app',
				appSlug: 'missing',
			}),
		}),
		params: {},
	} as never)
	expect(missingApp.status).toBe(404)
})

test('integrations API sets usage, returns approval payload, and grants a package without widening any', async () => {
	const handler = createAccountIntegrationsApiHandler(createEnv())
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'pkg-mail',
			userId: 'stable-user-1',
			name: 'mail',
			kodyId: 'mail',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-mail',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: createdAt,
			updatedAt: updatedAt,
		},
	])

	const usageResponse = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'set_usage',
				name: 'google',
				usageMode: 'packages',
				allowedPackageIds: ['pkg-mail'],
			}),
		}),
		params: {},
	} as never)
	expect(usageResponse.status).toBe(200)
	expect(mockModule.setIntegrationUsage).toHaveBeenCalledWith({
		env: expect.any(Object),
		userId: 'stable-user-1',
		name: 'google',
		usageMode: 'packages',
		allowedPackageIds: ['pkg-mail'],
	})
	await expect(usageResponse.json()).resolves.toEqual({
		ok: true,
		usageMode: 'packages',
		allowedPackageIds: ['pkg-mail'],
	})

	const approvalGet = await handler.handler({
		request: new Request(
			'https://example.com/account/integrations.json?name=google&package_id=pkg-mail',
		),
		params: {},
	} as never)
	expect(approvalGet.status).toBe(200)
	const approvalPayload = await approvalGet.json()
	expect(approvalPayload).toMatchObject({
		ok: true,
		approval: {
			name: 'google',
			packageId: 'pkg-mail',
			packageKodyId: 'mail',
			usageMode: 'any',
			alreadyGranted: true,
		},
	})
	expect(approvalPayload.integration).toBeUndefined()

	mockModule.grantIntegrationPackage.mockResolvedValueOnce({
		name: 'google',
		usageMode: 'any',
		allowedPackageIds: [],
	})
	const approveAny = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'approve_package',
				name: 'google',
				packageId: 'pkg-mail',
			}),
		}),
		params: {},
	} as never)
	expect(approveAny.status).toBe(200)
	await expect(approveAny.json()).resolves.toEqual({
		ok: true,
		alreadyGranted: true,
		usageMode: 'any',
		allowedPackageIds: [],
	})

	const missingPackage = await handler.handler({
		request: new Request('https://example.com/account/integrations.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'approve_package',
				name: 'google',
				packageId: 'pkg-missing',
			}),
		}),
		params: {},
	} as never)
	expect(missingPackage.status).toBe(400)
})
