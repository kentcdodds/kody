import { expect, test, vi } from 'vitest'
import type * as AllowedCapabilities from '#mcp/secrets/allowed-capabilities.ts'

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
	getAppBaseUrl: () => 'https://example.com',
	saveSecret: vi.fn(async () => ({
		name: 'githubAccessToken',
		scope: 'user',
		description: '',
		packageId: null,
		allowedHosts: [],
		allowedCapabilities: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		ttlMs: null,
	})),
	setSecretAllowedHosts: vi.fn(async () => undefined),
	saveValue: vi.fn(async () => undefined),
	buildSecretHostApprovalUrl: vi.fn(
		(input: { name: string; requestedHost: string }) =>
			`https://example.com/account/secrets/user/${input.name}?allowed-host=${input.requestedHost}`,
	),
	listSavedPackagesByUserId: vi.fn(async () => []),
	listSecrets: vi.fn(async () => []),
	listPackageSecretsByPackageIds: vi.fn(async () => []),
	resolveSecret: vi.fn(async () => ({ found: false, value: null })),
	deleteSecret: vi.fn(async () => false),
	setSecretAllowedCapabilities: vi.fn(async () => undefined),
	setSecretAllowedPackages: vi.fn(async () => undefined),
	getValue: vi.fn(async () => null),
	upsertIntegration: vi.fn(async (input: { config: { name: string } }) => ({
		...input.config,
		name: String(input.config.name).toLowerCase(),
	})),
	upsertOauthAppWithoutConnection: vi.fn(
		async (input: {
			config: {
				name: string
				clientId: string
				tokenUrl: string
				flow: 'pkce' | 'confidential'
				clientSecretSecretName?: string | null
				apiBaseUrl?: string | null
				usePkce?: boolean | null
				tokenExchangeStyle?: string | null
			}
		}) => ({
			userId: 'stable-user-1',
			slug: String(input.config.name).toLowerCase().replace(/\s+/g, '-'),
			provider: String(input.config.name)
				.toLowerCase()
				.replace(/\s+/g, '-')
				.split('-')[0],
			label: null,
			clientId: input.config.clientId,
			clientSecretSecretName: input.config.clientSecretSecretName ?? null,
			tokenUrl: input.config.tokenUrl,
			authorizeUrl: null,
			apiBaseUrl: input.config.apiBaseUrl ?? null,
			flow: input.config.flow,
			usePkce: input.config.usePkce ?? null,
			tokenExchangeStyle: input.config.tokenExchangeStyle ?? null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		}),
	),
	searchCommunityListings: vi.fn(async () => []),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
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

vi.mock('#app/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#mcp/secrets/allowed-hosts.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#mcp/secrets/allowed-hosts.ts')>()
	return {
		normalizeAllowedHosts: actual.normalizeAllowedHosts,
		normalizeHost: actual.normalizeHost,
	}
})

vi.mock('#mcp/secrets/allowed-capabilities.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AllowedCapabilities>()
	return {
		...actual,
		normalizeAllowedCapabilities: (capabilities: Array<string>) => capabilities,
	}
})

vi.mock('#mcp/secrets/host-approval.ts', () => ({
	buildSecretHostApprovalUrl: (...args: Array<unknown>) =>
		mockModule.buildSecretHostApprovalUrl(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	saveSecret: (...args: Array<unknown>) => mockModule.saveSecret(...args),
	setSecretAllowedHosts: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedHosts(...args),
	listSecrets: (...args: Array<unknown>) => mockModule.listSecrets(...args),
	listPackageSecretsByPackageIds: (...args: Array<unknown>) =>
		mockModule.listPackageSecretsByPackageIds(...args),
	resolveSecret: (...args: Array<unknown>) => mockModule.resolveSecret(...args),
	deleteSecret: (...args: Array<unknown>) => mockModule.deleteSecret(...args),
	setSecretAllowedCapabilities: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedCapabilities(...args),
	setSecretAllowedPackages: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedPackages(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
	saveValue: (...args: Array<unknown>) => mockModule.saveValue(...args),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	upsertIntegration: (...args: Array<unknown>) =>
		mockModule.upsertIntegration(...args),
	upsertOauthAppWithoutConnection: (...args: Array<unknown>) =>
		mockModule.upsertOauthAppWithoutConnection(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

const { createAccountSecretsApiHandler } = await import('./account-secrets.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

test('save_oauth_app persists the app (client id + endpoints) before authorize redirect', async () => {
	mockModule.upsertOauthAppWithoutConnection.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())

	const response = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save_oauth_app',
				provider: 'GitHub',
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'pkce',
				usePkce: true,
				clientId: 'github-client-id-value',
				scopeSeparator: ' ',
				extraAuthorizeParams: { prompt: 'consent' },
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		app: {
			slug: 'github',
			clientId: 'github-client-id-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'pkce',
		},
	})
	expect(mockModule.upsertOauthAppWithoutConnection).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			config: expect.objectContaining({
				name: 'GitHub',
				clientId: 'github-client-id-value',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'pkce',
				usePkce: true,
				authorization: {
					authorizeUrl: 'https://github.com/login/oauth/authorize',
					scopes: [],
					scopeSeparator: ' ',
					extraAuthorizeParams: { prompt: 'consent' },
				},
			}),
		}),
	)
	expect(mockModule.upsertIntegration).not.toHaveBeenCalled()
	expect(mockModule.saveSecret).not.toHaveBeenCalled()
})

test('save_oauth_app reuses an existing app when setting up a second account with the same client credentials', async () => {
	mockModule.upsertOauthAppWithoutConnection.mockClear()
	mockModule.upsertOauthAppWithoutConnection.mockImplementation(
		async (input: { config: { name: string; clientId: string } }) => ({
			userId: 'stable-user-1',
			slug: 'google',
			provider: 'google',
			label: null,
			clientId: input.config.clientId,
			clientSecretSecretName: null,
			tokenUrl: 'https://oauth2.googleapis.com/token',
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			apiBaseUrl: 'https://www.googleapis.com',
			flow: 'pkce' as const,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		}),
	)
	const handler = createAccountSecretsApiHandler(createEnv())

	const first = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save_oauth_app',
				provider: 'google',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce',
				clientId: 'shared-google-client',
			}),
		}),
		params: {},
	} as never)
	expect(first.status).toBe(200)
	await expect(first.json()).resolves.toMatchObject({
		ok: true,
		app: { slug: 'google', clientId: 'shared-google-client' },
	})

	const second = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save_oauth_app',
				provider: 'google-calendar',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				apiBaseUrl: 'https://www.googleapis.com',
				flow: 'pkce',
				clientId: 'shared-google-client',
			}),
		}),
		params: {},
	} as never)
	expect(second.status).toBe(200)
	await expect(second.json()).resolves.toMatchObject({
		ok: true,
		app: { slug: 'google', clientId: 'shared-google-client' },
	})
	expect(mockModule.upsertOauthAppWithoutConnection).toHaveBeenCalledTimes(2)
	expect(mockModule.upsertIntegration).not.toHaveBeenCalled()
})

test('connect oauth saves tokens via the secret store and persists app+connection through the integrations service', async () => {
	mockModule.upsertIntegration.mockClear()
	mockModule.saveSecret.mockClear()
	mockModule.buildSecretHostApprovalUrl.mockClear()
	mockModule.setSecretAllowedHosts.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())

	const githubResponse = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'GitHub',
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				scopes: ['repo', 'read:user'],
				scopeSeparator: ' ',
				extraAuthorizeParams: { prompt: 'consent' },
				flow: 'pkce',
				clientId: 'github-client-id-value',
				accessTokenSecretName: 'githubAccessToken',
				refreshTokenSecretName: 'githubRefreshToken',
				allowedHosts: ['api.github.com'],
				tokenPayload: {
					access_token: 'access-token',
					refresh_token: 'refresh-token',
				},
			}),
		}),
		params: {},
	} as never)

	expect(githubResponse.status).toBe(200)
	await expect(githubResponse.json()).resolves.toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		allowedHosts: ['api.github.com', 'github.com'],
		hostApprovalLinks: [
			{
				secretName: 'githubAccessToken',
				host: 'api.github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubAccessToken?allowed-host=api.github.com',
			},
			{
				secretName: 'githubAccessToken',
				host: 'github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubAccessToken?allowed-host=github.com',
			},
			{
				secretName: 'githubRefreshToken',
				host: 'api.github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubRefreshToken?allowed-host=api.github.com',
			},
			{
				secretName: 'githubRefreshToken',
				host: 'github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubRefreshToken?allowed-host=github.com',
			},
		],
		integrationName: 'github',
		nextSteps: {
			integrationName: 'github',
			guidance: expect.stringContaining('auth credentials only'),
			suggestions: [],
			createHelpersCta: {
				label: 'Create helpers package',
				prompt: expect.stringContaining('thin helpers package'),
			},
		},
	})
	expect(mockModule.buildSecretHostApprovalUrl).toHaveBeenCalledTimes(4)
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.saveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'githubAccessToken',
			value: 'access-token',
			scope: 'user',
		}),
	)
	expect(mockModule.saveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'githubRefreshToken',
			value: 'refresh-token',
			scope: 'user',
		}),
	)
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			config: expect.objectContaining({
				name: 'github',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'pkce',
				clientId: 'github-client-id-value',
				clientSecretSecretName: null,
				accessTokenSecretName: 'githubAccessToken',
				refreshTokenSecretName: 'githubRefreshToken',
				requiredHosts: ['api.github.com', 'github.com'],
				authorization: {
					authorizeUrl: 'https://github.com/login/oauth/authorize',
					scopes: ['repo', 'read:user'],
					scopeSeparator: null,
					extraAuthorizeParams: { prompt: 'consent' },
				},
			}),
		}),
	)
	expect(mockModule.saveValue).not.toHaveBeenCalled()

	mockModule.upsertIntegration.mockClear()
	const spotifyResponse = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'spotify',
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				tokenUrl: 'https://accounts.spotify.com/api/token',
				apiBaseUrl: 'https://api.spotify.com/v1',
				scopes: ['user-read-playback-state', 'playlist-modify-private'],
				scopeSeparator: ' ',
				extraAuthorizeParams: { show_dialog: 'true' },
				flow: 'pkce',
				clientId: 'spotify-client-id-value',
				accessTokenSecretName: 'spotifyAccessToken',
				refreshTokenSecretName: 'spotifyRefreshToken',
				allowedHosts: ['api.spotify.com'],
				tokenPayload: {
					access_token: 'newly-scoped-access-token',
					scope: 'user-read-playback-state playlist-modify-private',
				},
			}),
		}),
		params: {},
	} as never)

	expect(spotifyResponse.status).toBe(200)
	await expect(spotifyResponse.json()).resolves.toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: false,
		integrationName: 'spotify',
	})
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({
				name: 'spotify',
				clientId: 'spotify-client-id-value',
				refreshTokenSecretName: null,
			}),
		}),
	)

	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'spotifyAccessToken',
			scope: 'user',
			description: '',
			packageId: null,
			allowedHosts: ['api.spotify.com', 'accounts.spotify.com'],
			allowedCapabilities: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
		{
			name: 'spotifyRefreshToken',
			scope: 'user',
			description: '',
			packageId: null,
			allowedHosts: ['api.spotify.com', 'accounts.spotify.com'],
			allowedCapabilities: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.upsertIntegration.mockClear()
	const spotifyReconnect = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'spotify',
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				tokenUrl: 'https://accounts.spotify.com/api/token',
				apiBaseUrl: 'https://api.spotify.com/v1',
				scopes: ['user-read-playback-state'],
				flow: 'pkce',
				clientId: 'spotify-client-id-value',
				accessTokenSecretName: 'spotifyAccessToken',
				refreshTokenSecretName: 'spotifyRefreshToken',
				allowedHosts: ['api.spotify.com'],
				tokenPayload: {
					access_token: 'rotated-access-token',
				},
			}),
		}),
		params: {},
	} as never)
	expect(spotifyReconnect.status).toBe(200)
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({
				name: 'spotify',
				refreshTokenSecretName: 'spotifyRefreshToken',
			}),
		}),
	)

	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'teslaAccessToken',
			scope: 'user',
			description: '',
			packageId: null,
			allowedHosts: [
				'auth.tesla.com',
				'fleet-api.prd.na.vn.cloud.tesla.com',
				'fleet-auth.prd.vn.cloud.tesla.com',
			],
			allowedCapabilities: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
		{
			name: 'teslaRefreshToken',
			scope: 'user',
			description: '',
			packageId: null,
			allowedHosts: [
				'auth.tesla.com',
				'fleet-api.prd.na.vn.cloud.tesla.com',
				'fleet-auth.prd.vn.cloud.tesla.com',
			],
			allowedCapabilities: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])

	const teslaResponse = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'Tesla',
				tokenUrl: 'https://auth.tesla.com/oauth2/v3/token',
				apiBaseUrl: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
				flow: 'pkce',
				clientId: 'tesla-client-id-value',
				accessTokenSecretName: 'teslaAccessToken',
				refreshTokenSecretName: 'teslaRefreshToken',
				allowedHosts: [
					'fleet-api.prd.na.vn.cloud.tesla.com',
					'fleet-auth.prd.vn.cloud.tesla.com',
				],
				tokenPayload: {
					access_token: 'access-token',
					refresh_token: 'refresh-token',
				},
			}),
		}),
		params: {},
	} as never)

	expect(teslaResponse.status).toBe(200)
	const teslaPayload = await teslaResponse.json()
	expect(teslaPayload).toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		hostApprovalLinks: [],
		integrationName: 'tesla',
	})
	expect(teslaPayload.allowedHosts).toEqual(
		expect.arrayContaining([
			'auth.tesla.com',
			'fleet-api.prd.na.vn.cloud.tesla.com',
			'fleet-auth.prd.vn.cloud.tesla.com',
		]),
	)
})

test('connect oauth rejects invalid authorization metadata', async () => {
	mockModule.upsertIntegration.mockClear()

	const handler = createAccountSecretsApiHandler(createEnv())
	await expect(
		handler.handler({
			request: new Request('https://example.com/account/secrets.json', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'connect_oauth',
					provider: 'GitHub',
					authorizeUrl: 'ftp://github.com/login/oauth/authorize',
					tokenUrl: 'https://github.com/login/oauth/access_token',
					apiBaseUrl: 'https://api.github.com',
					scopes: ['repo'],
					flow: 'pkce',
					clientId: 'github-client-id-value',
					accessTokenSecretName: 'githubAccessToken',
					refreshTokenSecretName: 'githubRefreshToken',
					allowedHosts: ['api.github.com'],
					tokenPayload: {
						access_token: 'access-token',
						refresh_token: 'refresh-token',
					},
				}),
			}),
			params: {},
		} as never),
	).rejects.toThrow('OAuth integration configuration is invalid.')
	expect(mockModule.upsertIntegration).not.toHaveBeenCalled()
})

test('connect oauth normalizes URL-shaped allowed hosts to bare hostnames', async () => {
	mockModule.upsertIntegration.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())

	const response = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'linkedin',
				tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
				apiBaseUrl: 'https://api.linkedin.com',
				flow: 'pkce',
				clientId: 'linkedin-client-id',
				accessTokenSecretName: 'linkedinAccessToken',
				refreshTokenSecretName: 'linkedinRefreshToken',
				allowedHosts: ['https://api.linkedin.com', 'www.linkedin.com'],
				tokenPayload: {
					access_token: 'access-token',
				},
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		allowedHosts: ['api.linkedin.com', 'www.linkedin.com'],
		refreshTokenSaved: false,
	})
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({
				requiredHosts: ['api.linkedin.com', 'www.linkedin.com'],
				refreshTokenSecretName: null,
			}),
		}),
	)
})

test('connect oauth reuses an existing OAuth app when connecting a second account with the same client id', async () => {
	mockModule.upsertIntegration.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())

	const first = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'google',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				apiBaseUrl: 'https://www.googleapis.com',
				scopes: ['openid', 'email'],
				flow: 'pkce',
				clientId: 'shared-google-client',
				accessTokenSecretName: 'googleAccessToken',
				refreshTokenSecretName: 'googleRefreshToken',
				allowedHosts: ['www.googleapis.com'],
				tokenPayload: {
					access_token: 'google-access-1',
					refresh_token: 'google-refresh-1',
				},
			}),
		}),
		params: {},
	} as never)
	expect(first.status).toBe(200)

	const second = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'google-calendar',
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				apiBaseUrl: 'https://www.googleapis.com',
				scopes: ['calendar.readonly'],
				flow: 'pkce',
				clientId: 'shared-google-client',
				accessTokenSecretName: 'googleCalendarAccessToken',
				refreshTokenSecretName: 'googleCalendarRefreshToken',
				allowedHosts: ['www.googleapis.com'],
				tokenPayload: {
					access_token: 'google-access-2',
					refresh_token: 'google-refresh-2',
				},
			}),
		}),
		params: {},
	} as never)
	expect(second.status).toBe(200)

	expect(mockModule.upsertIntegration).toHaveBeenCalledTimes(2)
	expect(mockModule.upsertIntegration.mock.calls[0]?.[0]).toMatchObject({
		config: {
			name: 'google',
			clientId: 'shared-google-client',
		},
	})
	expect(mockModule.upsertIntegration.mock.calls[1]?.[0]).toMatchObject({
		config: {
			name: 'google-calendar',
			clientId: 'shared-google-client',
		},
	})
})

test('host approval view and approve persist normalized hosts for the selected secret', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'cloudflareToken',
			scope: 'user',
			description: 'Cloudflare token',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'cloudflareToken',
			scope: 'user',
			description: 'Cloudflare token',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])

	const handler = createAccountSecretsApiHandler(createEnv())
	const viewResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&allowed-host=API.Cloudflare.com',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(viewResponse.status).toBe(200)
	await expect(viewResponse.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: 'api.cloudflare.com',
			requestedPackageId: null,
			currentAllowedHosts: [],
		},
	})

	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'cloudflareToken',
			scope: 'user',
			description: 'Cloudflare token',
			packageId: null,
			allowedHosts: ['api.github.com'],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&allowed-host=API.Cloudflare.com',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'cloudflareToken',
			scope: 'user',
			allowedHosts: ['api.cloudflare.com', 'api.github.com'],
			storageContext: { sessionId: null, appId: null, packageId: null },
		}),
	)
})

test('approval request rejects ambiguous host and package targets', async () => {
	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&allowed-host=api.cloudflare.com&package_id=pkg-123',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: 'Approval request contains both host and package.',
	})
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()
})

test('account secrets payload includes all packages and package titles and allowed packages', async () => {
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'package-123',
			userId: 'stable-user-1',
			name: '@kentcdodds/discord-gateway',
			kodyId: 'discord-gateway',
			description: 'Discord gateway package',
			tags: ['discord'],
			searchText: null,
			sourceId: 'source-1',
			hasApp: true,
			hidden: false,
			isPrivate: false,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
		{
			id: 'pkg-allowed',
			userId: 'stable-user-1',
			name: '@kentcdodds/discord-general-chat',
			kodyId: 'discord-general-chat',
			description: 'Discord subscriber',
			tags: ['discord'],
			searchText: null,
			sourceId: 'source-2',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'discordBotToken',
			scope: 'user',
			description: 'Discord bot token',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: ['pkg-allowed'],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(
		new Map([
			[
				'package-123',
				[
					{
						name: 'gatewaySigningSecret',
						scope: 'package',
						description: 'Gateway signing secret',
						packageId: 'package-123',
						allowedHosts: [],
						allowedCapabilities: [],
						allowedPackages: [],
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						ttlMs: null,
					},
				],
			],
		]),
	)

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'GET',
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		secrets: expect.arrayContaining([
			expect.objectContaining({
				name: 'discordBotToken',
				scope: 'user',
				allowedPackages: ['pkg-allowed'],
			}),
			expect.objectContaining({
				name: 'gatewaySigningSecret',
				scope: 'package',
				packageTitle: '@kentcdodds/discord-gateway',
			}),
		]),
	})
})

test('capability approval view, reject, approve, and dedupe mirror host/package flow', async () => {
	mockModule.setSecretAllowedCapabilities.mockClear()
	mockModule.setSecretAllowedHosts.mockClear()
	mockModule.setSecretAllowedPackages.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())
	const secret = {
		name: 'cloudflareToken',
		scope: 'user' as const,
		description: 'Cloudflare token',
		packageId: null,
		allowedHosts: [],
		allowedCapabilities: ['secret_get'],
		allowedPackages: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		ttlMs: null,
	}

	mockModule.listSecrets.mockResolvedValueOnce([secret])
	mockModule.listSecrets.mockResolvedValueOnce([secret])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const viewResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=secret_set',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(viewResponse.status).toBe(200)
	await expect(viewResponse.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: '',
			requestedCapability: 'secret_set',
			requestedPackageId: null,
			currentAllowedCapabilities: ['secret_get'],
		},
	})

	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const rejectResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=secret_set',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reject' }),
			},
		),
		params: {},
	} as never)

	expect(rejectResponse.status).toBe(200)
	await expect(rejectResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()

	mockModule.listSecrets.mockResolvedValueOnce([
		{
			...secret,
			allowedCapabilities: ['secret_get', 'secret_get'],
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=secret_set',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedCapabilities).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'cloudflareToken',
			scope: 'user',
			allowedCapabilities: ['secret_get', 'secret_set'],
			storageContext: { sessionId: null, appId: null, packageId: null },
		}),
	)

	mockModule.setSecretAllowedCapabilities.mockClear()
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			...secret,
			allowedCapabilities: ['secret_set'],
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const dedupeResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=secret_set',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(dedupeResponse.status).toBe(200)
	await expect(dedupeResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedCapabilities).toHaveBeenCalledWith(
		expect.objectContaining({
			allowedCapabilities: ['secret_set'],
		}),
	)
})

test('capability approval rejects invalid targets and defers to host when both are present', async () => {
	mockModule.setSecretAllowedCapabilities.mockClear()
	mockModule.setSecretAllowedHosts.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())

	const missingTargetResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(missingTargetResponse.status).toBe(400)
	await expect(missingTargetResponse.json()).resolves.toMatchObject({
		ok: false,
		error: 'Approval request is missing a host, package, or capability.',
	})
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()

	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'cloudflareToken',
			scope: 'user',
			description: 'Cloudflare token',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const hostPrecedenceResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&allowed-host=api.cloudflare.com&capability=secret_set',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(hostPrecedenceResponse.status).toBe(200)
	await expect(hostPrecedenceResponse.json()).resolves.toMatchObject({
		ok: true,
	})
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalled()
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()
})

test('capability approval rejects junk and oversized capability names without policy change', async () => {
	mockModule.setSecretAllowedCapabilities.mockClear()
	const handler = createAccountSecretsApiHandler(createEnv())

	const junkResponse = await handler.handler({
		request: new Request(
			`https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=${encodeURIComponent('evil name<script>')}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(junkResponse.status).toBe(400)
	await expect(junkResponse.json()).resolves.toMatchObject({
		ok: false,
		error: 'Invalid approval request capability.',
	})
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()

	const oversizedCapability = 'a'.repeat(201)
	const oversizedResponse = await handler.handler({
		request: new Request(
			`https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=${encodeURIComponent(oversizedCapability)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(oversizedResponse.status).toBe(400)
	await expect(oversizedResponse.json()).resolves.toMatchObject({
		ok: false,
		error: 'Invalid approval request capability.',
	})
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()

	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const junkViewResponse = await handler.handler({
		request: new Request(
			`https://example.com/account/secrets.json?selected=user::::cloudflareToken&capability=${encodeURIComponent('evil name<script>')}`,
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(junkViewResponse.status).toBe(200)
	await expect(junkViewResponse.json()).resolves.toMatchObject({
		ok: true,
		approval: null,
		approvalError: 'Invalid approval request capability.',
	})
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()
})

test('package approval reject and approve handle missing secrets and deduplicate package ids', async () => {
	const handler = createAccountSecretsApiHandler(createEnv())
	const savedPackages = [
		{
			id: 'pkg-allowed',
			kodyId: 'allowed-pkg',
			name: '@user/allowed-pkg',
			updatedAt: new Date(0).toISOString(),
		},
		{
			id: 'pkg-new',
			kodyId: 'new-pkg',
			name: '@user/new-pkg',
			updatedAt: new Date(0).toISOString(),
		},
	]

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(savedPackages)
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const rejectResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::discordBotToken&package_id=pkg-allowed',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reject' }),
			},
		),
		params: {},
	} as never)

	expect(rejectResponse.status).toBe(200)
	await expect(rejectResponse.json()).resolves.toMatchObject({
		ok: true,
		secrets: [],
	})
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(savedPackages)
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'discordBotToken',
			scope: 'user',
			description: 'Discord bot token',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: ['pkg-allowed', 'pkg-allowed'],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(savedPackages)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::discordBotToken&package_id=pkg-new',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'discordBotToken',
			scope: 'user',
			allowedPackages: ['pkg-allowed', 'pkg-new'],
		}),
	)
})

test('bulk package approval view and approve grant the package on every listed secret', async () => {
	const handler = createAccountSecretsApiHandler(createEnv())
	const savedPackages = [
		{
			id: 'pkg-release',
			kodyId: 'release',
			name: '@kentcdodds/release',
			updatedAt: new Date(0).toISOString(),
		},
	]
	const secrets = [
		{
			name: 'discordBotToken',
			scope: 'user' as const,
			description: 'Discord',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
		{
			name: 'xAccessToken',
			scope: 'user' as const,
			description: 'X',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
		{
			name: 'githubAccessToken',
			scope: 'user' as const,
			description: 'GitHub',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: ['pkg-release'],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	]

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(savedPackages)
	mockModule.listSecrets.mockResolvedValueOnce(secrets)
	mockModule.listSecrets.mockResolvedValueOnce(secrets)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const viewResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?package_id=pkg-release&names=discordBotToken,xAccessToken,githubAccessToken',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(viewResponse.status).toBe(200)
	await expect(viewResponse.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			names: ['discordBotToken', 'xAccessToken'],
			requestedPackageId: 'pkg-release',
			scope: 'user',
		},
	})

	mockModule.setSecretAllowedPackages.mockClear()
	mockModule.listSavedPackagesByUserId.mockResolvedValue(savedPackages)
	mockModule.listSecrets.mockResolvedValue(secrets)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())

	const approveResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?package_id=pkg-release&names=discordBotToken,xAccessToken,githubAccessToken',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve' }),
			},
		),
		params: {},
	} as never)

	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledTimes(2)
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'discordBotToken',
			allowedPackages: ['pkg-release'],
		}),
	)
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'xAccessToken',
			allowedPackages: ['pkg-release'],
		}),
	)

	mockModule.listSavedPackagesByUserId.mockReset()
	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	mockModule.listSecrets.mockReset()
	mockModule.listSecrets.mockResolvedValue([])
	mockModule.listPackageSecretsByPackageIds.mockReset()
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())
})

test('account secrets API loads selected secret values and deletes the selected user secret', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'myApiKey',
			scope: 'user',
			description: 'API key',
			packageId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'seeded-secret-value',
	})

	const handler = createAccountSecretsApiHandler(createEnv())
	const getResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::myApiKey',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(getResponse.status).toBe(200)
	const getPayload = await getResponse.json()
	expect(getPayload.ok).toBe(true)
	expect(getPayload.selectedSecret).toMatchObject({
		name: 'myApiKey',
		description: 'API key',
		value: 'seeded-secret-value',
	})
	expect(mockModule.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'myApiKey',
			scope: 'user',
			storageContext: { sessionId: null, appId: null, packageId: null },
		}),
	)

	mockModule.deleteSecret.mockResolvedValueOnce(true)
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				currentId: 'user::::myApiKey',
			}),
		}),
		params: {},
	} as never)

	expect(deleteResponse.status).toBe(200)
	await expect(deleteResponse.json()).resolves.toMatchObject({
		ok: true,
		deleted: true,
		selectedSecret: null,
		secrets: [],
	})
	expect(mockModule.deleteSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'myApiKey',
			scope: 'user',
			storageContext: { sessionId: null, appId: null, packageId: null },
		}),
	)
})

test('oauth_exchange supports Notion basic-json and confidential form-body styles without leaking provider 401', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const handler = createAccountSecretsApiHandler(createEnv())

	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'notion-client-secret',
	})
	fetchMock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				access_token: 'notion-access',
				refresh_token: 'notion-refresh',
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		),
	)

	const notionSuccess = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'oauth_exchange',
				tokenUrl: 'https://api.notion.com/v1/oauth/token',
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: 'notion-client-id',
					code: 'auth-code',
					redirect_uri: 'https://example.com/connect/oauth',
				}).toString(),
				flow: 'confidential',
				clientSecretSecretName: 'notionClientSecret',
				allowedHosts: ['api.notion.com'],
			}),
		}),
		params: {},
	} as never)

	expect(notionSuccess.status).toBe(200)
	await expect(notionSuccess.json()).resolves.toMatchObject({
		access_token: 'notion-access',
		refresh_token: 'notion-refresh',
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const notionRequest = fetchMock.mock.calls[0]?.[1] as RequestInit
	expect(notionRequest.method).toBe('POST')
	expect(notionRequest.headers).toMatchObject({
		Accept: 'application/json',
		'Content-Type': 'application/json',
		Authorization: `Basic ${btoa('notion-client-id:notion-client-secret')}`,
	})
	expect(JSON.parse(String(notionRequest.body))).toEqual({
		grant_type: 'authorization_code',
		code: 'auth-code',
		redirect_uri: 'https://example.com/connect/oauth',
	})

	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'slack-client-secret',
	})
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify({ access_token: 'slack-access' }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}),
	)

	const formSuccess = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'oauth_exchange',
				tokenUrl: 'https://slack.com/api/oauth.v2.access',
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: 'slack-client-id',
					code: 'slack-code',
					redirect_uri: 'https://example.com/connect/oauth',
				}).toString(),
				flow: 'confidential',
				tokenExchangeStyle: 'form',
				clientSecretSecretName: 'slackClientSecret',
				allowedHosts: ['slack.com'],
			}),
		}),
		params: {},
	} as never)

	expect(formSuccess.status).toBe(200)
	await expect(formSuccess.json()).resolves.toMatchObject({
		access_token: 'slack-access',
	})
	expect(fetchMock).toHaveBeenCalledTimes(2)
	const formRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
	expect(formRequest.headers).toMatchObject({
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
	})
	expect(formRequest.headers).not.toHaveProperty('Authorization')
	expect(
		new URLSearchParams(String(formRequest.body)).get('client_secret'),
	).toBe('slack-client-secret')
	expect(new URLSearchParams(String(formRequest.body)).get('client_id')).toBe(
		'slack-client-id',
	)

	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'notion-client-secret',
	})
	fetchMock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				error: 'invalid_client',
				error_description: 'Client authentication failed',
			}),
			{ status: 401, headers: { 'Content-Type': 'application/json' } },
		),
	)

	const notionFailure = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'oauth_exchange',
				tokenUrl: 'https://api.notion.com/v1/oauth/token',
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: 'notion-client-id',
					code: 'bad-code',
					redirect_uri: 'https://example.com/connect/oauth',
				}).toString(),
				flow: 'confidential',
				clientSecretSecretName: 'notionClientSecret',
				allowedHosts: ['api.notion.com'],
			}),
		}),
		params: {},
	} as never)

	expect(notionFailure.status).toBe(502)
	await expect(notionFailure.json()).resolves.toEqual({
		ok: false,
		error: 'invalid_client',
		error_description: 'Client authentication failed',
		providerStatus: 401,
	})

	vi.unstubAllGlobals()
})

test('oauth_exchange supports Canva basic-form with PKCE code_verifier and a client secret together', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const handler = createAccountSecretsApiHandler(createEnv())

	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'canva-client-secret',
	})
	fetchMock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				access_token: 'canva-access',
				refresh_token: 'canva-refresh',
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		),
	)

	const canvaSuccess = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'oauth_exchange',
				tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: 'canva-client-id',
					code: 'canva-code',
					redirect_uri: 'https://example.com/connect/oauth',
					code_verifier: 'pkce-verifier',
				}).toString(),
				flow: 'confidential',
				clientSecretSecretName: 'canvaClientSecret',
				allowedHosts: ['api.canva.com'],
			}),
		}),
		params: {},
	} as never)

	expect(canvaSuccess.status).toBe(200)
	await expect(canvaSuccess.json()).resolves.toMatchObject({
		access_token: 'canva-access',
		refresh_token: 'canva-refresh',
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(fetchMock.mock.calls[0]?.[0]).toBe(
		'https://api.canva.com/rest/v1/oauth/token',
	)
	const canvaRequest = fetchMock.mock.calls[0]?.[1] as RequestInit
	expect(canvaRequest.method).toBe('POST')
	expect(canvaRequest.headers).toMatchObject({
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
		Authorization: `Basic ${btoa('canva-client-id:canva-client-secret')}`,
	})
	const canvaBody = new URLSearchParams(String(canvaRequest.body))
	expect(canvaBody.get('grant_type')).toBe('authorization_code')
	expect(canvaBody.get('code')).toBe('canva-code')
	expect(canvaBody.get('code_verifier')).toBe('pkce-verifier')
	expect(canvaBody.get('client_id')).toBeNull()
	expect(canvaBody.get('client_secret')).toBeNull()

	vi.unstubAllGlobals()
})

test('connect oauth persists usePkce for confidential + PKCE providers like Canva', async () => {
	mockModule.saveValue.mockClear()
	mockModule.searchCommunityListings.mockClear()
	mockModule.searchCommunityListings.mockResolvedValueOnce([
		{
			id: 'canva-untrusted',
			ownerUserId: 'owner',
			packageId: 'pkg',
			sourceId: 'src',
			kodyId: '@owner/canva-extra',
			name: 'canva-extra',
			description: 'Untrusted canva helpers',
			tags: [],
			searchText: null,
			readmeContent: null,
			license: 'MIT',
			pinnedCommit: 'abc',
			iconCommit: 'abc',
			status: 'active',
			trustedCommit: null,
			trustedAt: null,
			trusted: false,
			featuredAt: null,
			featured: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			publishedAt: '2026-01-01T00:00:00.000Z',
			averageStars: null,
			ratingCount: 0,
			averageAdaptationEffort: null,
			forkCount: 0,
			starCount: 0,
		},
		{
			id: 'canva-trusted',
			ownerUserId: 'owner',
			packageId: 'pkg-2',
			sourceId: 'src-2',
			kodyId: '@owner/canva-helpers',
			name: 'canva-helpers',
			description: 'Trusted canva helpers',
			tags: ['canva'],
			searchText: null,
			readmeContent: null,
			license: 'MIT',
			pinnedCommit: 'def',
			iconCommit: 'def',
			status: 'active',
			trustedCommit: 'def',
			trustedAt: '2026-01-01T00:00:00.000Z',
			trusted: true,
			featuredAt: null,
			featured: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			publishedAt: '2026-01-01T00:00:00.000Z',
			averageStars: 5,
			ratingCount: 2,
			averageAdaptationEffort: 1,
			forkCount: 3,
			starCount: 4,
		},
	])
	const handler = createAccountSecretsApiHandler(createEnv())

	const canvaResponse = await handler.handler({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'canva',
				authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
				tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
				apiBaseUrl: 'https://api.canva.com/rest/v1',
				scopes: ['design:content:read'],
				scopeSeparator: ' ',
				flow: 'confidential',
				usePkce: true,
				tokenExchangeStyle: 'basic-form',
				clientId: 'canva-client-id-value',
				clientSecretSecretName: 'canvaClientSecret',
				accessTokenSecretName: 'canvaAccessToken',
				refreshTokenSecretName: 'canvaRefreshToken',
				allowedHosts: ['api.canva.com'],
				tokenPayload: {
					access_token: 'access-token',
					refresh_token: 'refresh-token',
				},
			}),
		}),
		params: {},
	} as never)

	expect(canvaResponse.status).toBe(200)
	const canvaPayload = await canvaResponse.json()
	expect(canvaPayload).toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		integrationName: 'canva',
		nextSteps: {
			integrationName: 'canva',
			guidance: expect.stringContaining('auth credentials only'),
			createHelpersCta: {
				label: 'Create helpers package',
				prompt: expect.stringContaining('thin helpers package'),
			},
		},
	})
	expect(canvaPayload.nextSteps.suggestions).toHaveLength(2)
	expect(
		canvaPayload.nextSteps.suggestions.map(
			(entry: { listingId: string }) => entry.listingId,
		),
	).toEqual(['canva-trusted', 'canva-untrusted'])
	expect(canvaPayload.nextSteps.suggestions[0]).toMatchObject({
		listingId: 'canva-trusted',
		name: 'canva-helpers',
		trusted: true,
		publicUrl: 'https://example.com/community/canva-trusted',
		forkPrompt: expect.stringContaining('canva-helpers'),
	})
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env: expect.anything(),
		query: 'canva',
		limit: 12,
		trustedFirst: true,
	})
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({
				name: 'canva',
				tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
				apiBaseUrl: 'https://api.canva.com/rest/v1',
				flow: 'confidential',
				usePkce: true,
				clientId: 'canva-client-id-value',
				clientSecretSecretName: 'canvaClientSecret',
				accessTokenSecretName: 'canvaAccessToken',
				refreshTokenSecretName: 'canvaRefreshToken',
				requiredHosts: ['api.canva.com'],
				tokenExchangeStyle: 'basic-form',
				authorization: {
					authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
					scopes: ['design:content:read'],
					scopeSeparator: null,
					extraAuthorizeParams: {},
				},
			}),
		}),
	)
})
