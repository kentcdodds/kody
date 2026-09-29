import { expect, test, vi } from 'vitest'
import type * as AllowedHosts from '#mcp/secrets/allowed-hosts.ts'
import type * as HostApproval from '#mcp/secrets/host-approval.ts'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import type * as IntegrationsCredentials from '#worker/integrations/credentials.ts'

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
	saveSecret: vi.fn(async () => ({
		name: 'githubAccessToken',
		scope: 'user',
		description: '',
		packageId: null,
		allowedHosts: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		expiresAt: null,
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
				hasClientSecret?: boolean
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
			hasClientSecret: input.config.hasClientSecret === true,
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
	getAvailablePlatformApp: vi.fn(async () => null),
	upsertPlatformIntegration: vi.fn(
		async (input: { platformAppSlug: string; name?: string | null }) => ({
			name: String(input.name ?? input.platformAppSlug).toLowerCase(),
			platform: true,
		}),
	),
	getPlatformOauthAppClientSecret: vi.fn(async () => null),
	dispatchIntegrationAuthSucceededSubscriptionEvents: vi.fn(async () => []),
	persistIntegrationTokens: vi.fn(async () => undefined),
	persistUserOauthAppClientSecret: vi.fn(async () => undefined),
	resolveUserOauthAppClientSecret: vi.fn(async () => null),
	getOauthApp: vi.fn(async () => null),
	findOauthAppForProviderSetup: vi.fn(async () => null),
	getJoinedIntegration: vi.fn(async (input: { name: string }) => ({
		lane: 'user' as const,
		app: { slug: String(input.name).toLowerCase() },
		connection: { name: String(input.name).toLowerCase() },
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

vi.mock('#mcp/secrets/allowed-hosts.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AllowedHosts>()
	return {
		normalizeAllowedHosts: actual.normalizeAllowedHosts,
		normalizeHost: actual.normalizeHost,
	}
})

vi.mock('#mcp/secrets/host-approval.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof HostApproval>()
	return {
		...actual,
		buildSecretHostApprovalUrl: (...args: Array<unknown>) =>
			mockModule.buildSecretHostApprovalUrl(...args),
	}
})

vi.mock('#mcp/secrets/service.ts', () => ({
	saveSecret: (...args: Array<unknown>) => mockModule.saveSecret(...args),
	setSecretAllowedHosts: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedHosts(...args),
	listSecrets: (...args: Array<unknown>) => mockModule.listSecrets(...args),
	listPackageSecretsByPackageIds: (...args: Array<unknown>) =>
		mockModule.listPackageSecretsByPackageIds(...args),
	resolveSecret: (...args: Array<unknown>) => mockModule.resolveSecret(...args),
	deleteSecret: (...args: Array<unknown>) => mockModule.deleteSecret(...args),
	setSecretAllowedPackages: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedPackages(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
	saveValue: (...args: Array<unknown>) => mockModule.saveValue(...args),
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsService>()
	return {
		upsertIntegration: (...args: Array<unknown>) =>
			mockModule.upsertIntegration(...args),
		upsertOauthAppWithoutConnection: (...args: Array<unknown>) =>
			mockModule.upsertOauthAppWithoutConnection(...args),
		getAvailablePlatformApp: (...args: Array<unknown>) =>
			mockModule.getAvailablePlatformApp(...args),
		upsertPlatformIntegration: (...args: Array<unknown>) =>
			mockModule.upsertPlatformIntegration(...args),
		getJoinedIntegration: (...args: Array<unknown>) =>
			mockModule.getJoinedIntegration(...args),
		getOauthApp: (...args: Array<unknown>) => mockModule.getOauthApp(...args),
		findOauthAppForProviderSetup: (...args: Array<unknown>) =>
			mockModule.findOauthAppForProviderSetup(...args),
		// Real scope validation so handler ordering tests exercise the actual
		// allowlist semantics.
		assertScopesAllowedForPlatformApp: actual.assertScopesAllowedForPlatformApp,
	}
})

vi.mock('#worker/integrations/package-subscriptions.ts', () => ({
	dispatchIntegrationAuthSucceededSubscriptionEvents: (
		...args: Array<unknown>
	) => mockModule.dispatchIntegrationAuthSucceededSubscriptionEvents(...args),
	dispatchIntegrationAuthFailedSubscriptionEvents: vi.fn(async () => []),
	integrationAuthFailedTopic: 'integration.auth.failed',
	integrationAuthSucceededTopic: 'integration.auth.succeeded',
}))

vi.mock('#worker/integrations/platform-apps.ts', () => ({
	getPlatformOauthAppClientSecret: (...args: Array<unknown>) =>
		mockModule.getPlatformOauthAppClientSecret(...args),
}))

vi.mock('#worker/integrations/credentials.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IntegrationsCredentials>()
	return {
		...actual,
		persistIntegrationTokens: (...args: Array<unknown>) =>
			mockModule.persistIntegrationTokens(...args),
		persistUserOauthAppClientSecret: (...args: Array<unknown>) =>
			mockModule.persistUserOauthAppClientSecret(...args),
		resolveUserOauthAppClientSecret: (...args: Array<unknown>) =>
			mockModule.resolveUserOauthAppClientSecret(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

const { createAccountSecretsApiHandler } = await import('./account-secrets.ts')

const secretsUrl = 'https://example.com/account/secrets.json'
const epoch = new Date(0).toISOString()
const userStorage = { sessionId: null, appId: null, packageId: null }

function createHandler() {
	const { handler } = createAccountSecretsApiHandler({
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env)
	return (request: Request) => handler({ request, params: {} } as never)
}

function getRequest(search: string) {
	return new Request(`${secretsUrl}${search}`, { method: 'GET' })
}

function postRequest(body: Record<string, unknown>, search = '') {
	return new Request(`${secretsUrl}${search}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

const approve = (search: string) => postRequest({ action: 'approve' }, search)

function makeSecret(name: string, overrides: Record<string, unknown> = {}) {
	return {
		name,
		scope: 'user' as const,
		description: '',
		packageId: null,
		allowedHosts: [] as Array<string>,
		allowedPackages: [] as Array<string>,
		createdAt: epoch,
		updatedAt: epoch,
		expiresAt: null,
		ttlMs: null,
		...overrides,
	}
}

function mockSecretsListing(secrets: Array<unknown>) {
	mockModule.listSecrets.mockResolvedValue(secrets as never)
	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValue(new Map())
}

test('save_oauth_app persists the app (client id + endpoints) before authorize redirect', async () => {
	const call = createHandler()

	const response = await call(
		postRequest({
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
	)

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

	const slackResponse = await call(
		postRequest({
			action: 'save_oauth_app',
			provider: 'slack',
			authorizeUrl: 'https://slack.com/oauth/v2/authorize',
			tokenUrl: 'https://slack.com/api/oauth.v2.access',
			apiBaseUrl: 'https://slack.com/api',
			flow: 'confidential',
			clientId: 'slack-client-id',
			clientSecret: 'slack-client-secret',
		}),
	)

	expect(slackResponse.status).toBe(200)
	expect(mockModule.persistUserOauthAppClientSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			slug: 'slack',
			value: 'slack-client-secret',
		}),
	)
	expect(mockModule.deleteSecret).not.toHaveBeenCalled()
})

test('connect oauth saves tokens via the secret store and persists app+connection through the integrations service', async () => {
	const call = createHandler()

	const githubResponse = await call(
		postRequest({
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
	)

	expect(githubResponse.status).toBe(200)
	await expect(githubResponse.json()).resolves.toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		allowedHosts: ['api.github.com', 'github.com'],
		hostApprovalLinks: [],
		integrationName: 'github',
		nextSteps: expect.objectContaining({
			service: 'github',
			connectionName: 'github',
		}),
	})
	expect(mockModule.buildSecretHostApprovalUrl).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.saveSecret).not.toHaveBeenCalled()
	expect(mockModule.persistIntegrationTokens).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'github',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
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
	expect(
		mockModule.dispatchIntegrationAuthSucceededSubscriptionEvents,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			source: 'oauth_connect',
			integration: expect.objectContaining({ name: 'github', lane: 'user' }),
		}),
	)

	mockModule.upsertIntegration.mockClear()
	const spotifyConnect = {
		action: 'connect_oauth',
		provider: 'spotify',
		authorizeUrl: 'https://accounts.spotify.com/authorize',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientId: 'spotify-client-id-value',
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		allowedHosts: ['api.spotify.com'],
	}
	const spotifyResponse = await call(
		postRequest({
			...spotifyConnect,
			scopes: ['user-read-playback-state', 'playlist-modify-private'],
			scopeSeparator: ' ',
			extraAuthorizeParams: { show_dialog: 'true' },
			tokenPayload: {
				access_token: 'newly-scoped-access-token',
				scope: 'user-read-playback-state playlist-modify-private',
			},
		}),
	)

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
			}),
		}),
	)
	expect(mockModule.persistIntegrationTokens).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'spotify',
			accessToken: 'newly-scoped-access-token',
		}),
	)

	const spotifyHosts = ['api.spotify.com', 'accounts.spotify.com']
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('spotifyAccessToken', { allowedHosts: spotifyHosts }),
		makeSecret('spotifyRefreshToken', { allowedHosts: spotifyHosts }),
	] as never)
	mockModule.upsertIntegration.mockClear()
	const spotifyReconnect = await call(
		postRequest({
			...spotifyConnect,
			scopes: ['user-read-playback-state'],
			tokenPayload: { access_token: 'rotated-access-token' },
		}),
	)
	expect(spotifyReconnect.status).toBe(200)
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({ name: 'spotify' }),
		}),
	)
	expect(mockModule.persistIntegrationTokens).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'spotify',
			accessToken: 'rotated-access-token',
		}),
	)

	const teslaHosts = [
		'auth.tesla.com',
		'fleet-api.prd.na.vn.cloud.tesla.com',
		'fleet-auth.prd.vn.cloud.tesla.com',
	]
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('teslaAccessToken', { allowedHosts: teslaHosts }),
		makeSecret('teslaRefreshToken', { allowedHosts: teslaHosts }),
	] as never)

	const teslaResponse = await call(
		postRequest({
			action: 'connect_oauth',
			provider: 'Tesla',
			tokenUrl: 'https://auth.tesla.com/oauth2/v3/token',
			apiBaseUrl: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
			flow: 'pkce',
			clientId: 'tesla-client-id-value',
			accessTokenSecretName: 'teslaAccessToken',
			refreshTokenSecretName: 'teslaRefreshToken',
			allowedHosts: teslaHosts.slice(1),
			tokenPayload: {
				access_token: 'access-token',
				refresh_token: 'refresh-token',
			},
		}),
	)

	expect(teslaResponse.status).toBe(200)
	const teslaPayload = await teslaResponse.json()
	expect(teslaPayload).toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		hostApprovalLinks: [],
		integrationName: 'tesla',
	})
	expect(teslaPayload.allowedHosts).toEqual(expect.arrayContaining(teslaHosts))
})

test('connect oauth rejects invalid authorization metadata', async () => {
	await expect(
		createHandler()(
			postRequest({
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
		),
	).rejects.toThrow('OAuth integration configuration is invalid.')
	expect(mockModule.upsertIntegration).not.toHaveBeenCalled()
})

test('host approval view and approve persist normalized hosts for the selected secret', async () => {
	const cloudflareToken = makeSecret('cloudflareToken', {
		description: 'Cloudflare token',
	})
	mockModule.listSecrets.mockResolvedValueOnce([cloudflareToken] as never)
	mockModule.listSecrets.mockResolvedValueOnce([cloudflareToken] as never)

	const call = createHandler()
	const selected =
		'?selected=user::::cloudflareToken&allowed-host=API.Cloudflare.com'
	const viewResponse = await call(getRequest(selected))

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
		{ ...cloudflareToken, allowedHosts: ['api.github.com'] },
	] as never)
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await call(approve(selected))

	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'cloudflareToken',
			scope: 'user',
			allowedHosts: ['api.cloudflare.com', 'api.github.com'],
			storageContext: userStorage,
		}),
	)
})

test('host bulk approval adds every requested host to each listed secret', async () => {
	mockSecretsListing([
		makeSecret('cloudflareToken', { allowedHosts: ['api.github.com'] }),
	])

	const call = createHandler()
	const bulk =
		'?names=cloudflareToken&hosts=api.cloudflare.com,dash.cloudflare.com'
	const viewResponse = await call(getRequest(bulk))
	expect(viewResponse.status).toBe(200)
	await expect(viewResponse.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			name: 'cloudflareToken',
			names: ['cloudflareToken'],
			requestedHost: 'api.cloudflare.com',
			requestedHosts: ['api.cloudflare.com', 'dash.cloudflare.com'],
			requestedPackageId: null,
		},
	})

	const approveResponse = await call(approve(bulk))
	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'cloudflareToken',
			scope: 'user',
			allowedHosts: [
				'api.cloudflare.com',
				'api.github.com',
				'dash.cloudflare.com',
			],
		}),
	)
})

test('host approval rejects truncated and malformed hosts instead of writing them', async () => {
	mockSecretsListing([makeSecret('openaiApiKey')])

	const call = createHandler()
	const mixed = '?names=openaiApiKey&hosts=hooks.slack.com,api.ope'
	const mixedView = await call(getRequest(mixed))
	expect(mixedView.status).toBe(200)
	await expect(mixedView.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			name: 'openaiApiKey',
			names: ['openaiApiKey'],
			requestedHost: 'hooks.slack.com',
			requestedHosts: ['hooks.slack.com'],
			rejectedHosts: [{ host: 'api.ope', reason: 'unknown_suffix' }],
		},
	})

	const mixedApprove = await call(approve(mixed))
	expect(mixedApprove.status).toBe(200)
	await expect(mixedApprove.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			requestedHosts: ['hooks.slack.com'],
			rejectedHosts: [{ host: 'api.ope', reason: 'unknown_suffix' }],
		},
	})
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'openaiApiKey',
			allowedHosts: ['hooks.slack.com'],
		}),
	)

	mockModule.setSecretAllowedHosts.mockClear()
	const invalidOnlyView = await call(
		getRequest('?names=openaiApiKey&hosts=api.openai.com/v1,%20%20,api.ope'),
	)
	expect(invalidOnlyView.status).toBe(200)
	await expect(invalidOnlyView.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			requestedHosts: [],
			rejectedHosts: [
				{ host: 'api.ope', reason: 'unknown_suffix' },
				{ host: 'api.openai.com/v1', reason: 'malformed' },
			],
		},
	})

	const invalidOnlyApprove = await call(
		approve('?names=openaiApiKey&hosts=api.ope'),
	)
	expect(invalidOnlyApprove.status).toBe(400)
	await expect(invalidOnlyApprove.json()).resolves.toMatchObject({
		ok: false,
		error:
			'None of the requested hosts are valid. The approval link may have been truncated — copy it again.',
	})
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
})

test('approval requests reject invalid targets and ignore stale capability query params', async () => {
	const call = createHandler()
	const selected = '?selected=user::::cloudflareToken'

	const rejected: Array<[string, string]> = [
		[
			`${selected}&allowed-host=api.cloudflare.com&package_id=pkg-123`,
			'Approval request contains both host and package.',
		],
		[selected, 'Approval request is missing a host or package.'],
		[
			`${selected}&capability=secretSet`,
			'Approval request is missing a host or package.',
		],
	]
	for (const [search, error] of rejected) {
		const response = await call(approve(search))
		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toMatchObject({ ok: false, error })
	}
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()

	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())
	const staleCapabilityView = await call(
		getRequest(`${selected}&capability=secretSet`),
	)
	expect(staleCapabilityView.status).toBe(200)
	await expect(staleCapabilityView.json()).resolves.toMatchObject({
		ok: true,
		approval: null,
		approvalError: null,
	})
})

test('account secrets payload includes all packages and package titles and allowed packages', async () => {
	const makePackage = (id: string, kodyId: string, hasApp: boolean) => ({
		id,
		userId: 'stable-user-1',
		name: `@kentcdodds/${kodyId}`,
		kodyId,
		description: kodyId,
		tags: ['discord'],
		searchText: null,
		sourceId: `source-${id}`,
		hasApp,
		hidden: false,
		isPrivate: false,
		createdAt: epoch,
		updatedAt: epoch,
	})
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		makePackage('package-123', 'discord-gateway', true),
		makePackage('pkg-allowed', 'discord-general-chat', false),
	] as never)
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('discordBotToken', { allowedPackages: ['pkg-allowed'] }),
	] as never)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(
		new Map([
			[
				'package-123',
				[
					makeSecret('gatewaySigningSecret', {
						scope: 'package',
						packageId: 'package-123',
					}),
				],
			],
		]) as never,
	)

	const response = await createHandler()(getRequest(''))

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

test('package approval reject and approve handle missing secrets and deduplicate package ids', async () => {
	const call = createHandler()
	const savedPackages = ['allowed', 'new'].map((suffix) => ({
		id: `pkg-${suffix}`,
		kodyId: `${suffix}-pkg`,
		name: `@user/${suffix}-pkg`,
		updatedAt: epoch,
	}))

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(
		savedPackages as never,
	)
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const rejectResponse = await call(
		postRequest(
			{ action: 'reject' },
			'?selected=user::::discordBotToken&package_id=pkg-allowed',
		),
	)

	expect(rejectResponse.status).toBe(200)
	await expect(rejectResponse.json()).resolves.toMatchObject({
		ok: true,
		secrets: [],
	})
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedPackages).not.toHaveBeenCalled()

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(
		savedPackages as never,
	)
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('discordBotToken', {
			allowedPackages: ['pkg-allowed', 'pkg-allowed'],
		}),
	] as never)
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce(
		savedPackages as never,
	)
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const approveResponse = await call(
		approve('?selected=user::::discordBotToken&package_id=pkg-new'),
	)

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
	const call = createHandler()
	mockSecretsListing([
		makeSecret('discordBotToken'),
		makeSecret('xAccessToken'),
		makeSecret('githubAccessToken', { allowedPackages: ['pkg-release'] }),
	])
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'pkg-release',
			kodyId: 'release',
			name: '@kentcdodds/release',
			updatedAt: epoch,
		},
	] as never)
	const bulk =
		'?package_id=pkg-release&names=discordBotToken,xAccessToken,githubAccessToken'

	const viewResponse = await call(getRequest(bulk))

	expect(viewResponse.status).toBe(200)
	await expect(viewResponse.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			names: ['discordBotToken', 'xAccessToken'],
			requestedPackageId: 'pkg-release',
			scope: 'user',
		},
	})

	const approveResponse = await call(approve(bulk))

	expect(approveResponse.status).toBe(200)
	await expect(approveResponse.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledTimes(2)
	for (const name of ['discordBotToken', 'xAccessToken']) {
		expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledWith(
			expect.objectContaining({ name, allowedPackages: ['pkg-release'] }),
		)
	}
})

test('account secrets API loads selected secret values and deletes the selected user secret', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		makeSecret('myApiKey', { description: 'API key' }),
	] as never)
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'seeded-secret-value',
	} as never)

	const call = createHandler()
	const getResponse = await call(getRequest('?selected=user::::myApiKey'))

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
			storageContext: userStorage,
		}),
	)

	mockModule.deleteSecret.mockResolvedValueOnce(true)
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(new Map())

	const deleteResponse = await call(
		postRequest({ action: 'delete', currentId: 'user::::myApiKey' }),
	)

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
			storageContext: userStorage,
		}),
	)
})

test('oauth_exchange maps provider failures and forwards exchange styles', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const call = createHandler()
	const jsonResponse = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})
	const exchange = (
		tokenUrl: string,
		params: Record<string, string>,
		extra: Record<string, unknown>,
	) =>
		call(
			postRequest({
				action: 'oauth_exchange',
				tokenUrl,
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					redirect_uri: 'https://example.com/connect/oauth',
					...params,
				}).toString(),
				flow: 'confidential',
				...extra,
			}),
		)
	const notion = {
		clientSecret: 'notion-client-secret',
		allowedHosts: ['api.notion.com'],
	}
	const notionTokenUrl = 'https://api.notion.com/v1/oauth/token'

	fetchMock.mockResolvedValueOnce(
		jsonResponse({
			access_token: 'notion-access',
			refresh_token: 'notion-refresh',
		}),
	)
	const notionSuccess = await exchange(
		notionTokenUrl,
		{ client_id: 'notion-client-id', code: 'auth-code' },
		notion,
	)
	expect(notionSuccess.status).toBe(200)
	await expect(notionSuccess.json()).resolves.toMatchObject({
		access_token: 'notion-access',
		refresh_token: 'notion-refresh',
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)

	fetchMock.mockResolvedValueOnce(
		jsonResponse({ access_token: 'slack-access' }),
	)
	const formSuccess = await exchange(
		'https://slack.com/api/oauth.v2.access',
		{ client_id: 'slack-client-id', code: 'slack-code' },
		{
			tokenExchangeStyle: 'form',
			clientSecret: 'slack-client-secret',
			allowedHosts: ['slack.com'],
		},
	)
	expect(formSuccess.status).toBe(200)
	await expect(formSuccess.json()).resolves.toMatchObject({
		access_token: 'slack-access',
	})

	fetchMock.mockResolvedValueOnce(
		jsonResponse({
			access_token: 'canva-access',
			refresh_token: 'canva-refresh',
		}),
	)
	const canvaSuccess = await exchange(
		'https://api.canva.com/rest/v1/oauth/token',
		{
			client_id: 'canva-client-id',
			code: 'canva-code',
			code_verifier: 'pkce-verifier',
		},
		{ clientSecret: 'canva-client-secret', allowedHosts: ['api.canva.com'] },
	)
	expect(canvaSuccess.status).toBe(200)
	await expect(canvaSuccess.json()).resolves.toMatchObject({
		access_token: 'canva-access',
		refresh_token: 'canva-refresh',
	})
	expect(fetchMock).toHaveBeenCalledTimes(3)

	fetchMock.mockResolvedValueOnce(
		jsonResponse(
			{
				error: 'invalid_client',
				error_description: 'Client authentication failed',
			},
			401,
		),
	)
	const notionFailure = await exchange(
		notionTokenUrl,
		{ client_id: 'notion-client-id', code: 'bad-code' },
		notion,
	)
	expect(notionFailure.status).toBe(502)
	const notionFailureBody = await notionFailure.text()
	expect(JSON.parse(notionFailureBody)).toEqual({
		ok: false,
		error: 'invalid_client',
		error_description: 'Client authentication failed',
		providerStatus: 401,
	})
	expect(notionFailureBody).not.toContain('notion-client-secret')

	vi.unstubAllGlobals()
})

test('connect oauth persists usePkce for confidential + PKCE providers like Canva', async () => {
	const canvaResponse = await createHandler()(
		postRequest({
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
			allowedHosts: ['api.canva.com'],
			tokenPayload: {
				access_token: 'access-token',
				refresh_token: 'refresh-token',
			},
		}),
	)

	expect(canvaResponse.status).toBe(200)
	await expect(canvaResponse.json()).resolves.toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		integrationName: 'canva',
		nextSteps: expect.objectContaining({
			service: 'canva',
			connectionName: 'canva',
		}),
	})
	expect(mockModule.deleteSecret).not.toHaveBeenCalled()
	expect(mockModule.upsertIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			config: expect.objectContaining({
				name: 'canva',
				tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
				apiBaseUrl: 'https://api.canva.com/rest/v1',
				flow: 'confidential',
				usePkce: true,
				clientId: 'canva-client-id-value',
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

test('platform-lane oauth exchange and connect are rejected', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const call = createHandler()
	const retired = {
		ok: false,
		error:
			'Built-in platform OAuth apps are no longer a connect path. Create your own OAuth app and connect it at /connect/oauth.',
	}

	const exchangeResponse = await call(
		postRequest({
			action: 'oauth_exchange',
			platformAppSlug: 'github',
			params: 'grant_type=authorization_code',
		}),
	)
	expect(exchangeResponse.status).toBe(400)
	await expect(exchangeResponse.json()).resolves.toEqual(retired)
	expect(fetchMock).not.toHaveBeenCalled()

	const connectResponse = await call(
		postRequest({
			action: 'connect_oauth',
			provider: 'github',
			platformAppSlug: 'github',
			scopes: ['read:user'],
			accessTokenSecretName: 'githubAccessToken',
			tokenPayload: { access_token: 'gh-access-token' },
		}),
	)
	expect(connectResponse.status).toBe(400)
	await expect(connectResponse.json()).resolves.toEqual(retired)
	expect(mockModule.upsertPlatformIntegration).not.toHaveBeenCalled()
	expect(mockModule.saveSecret).not.toHaveBeenCalled()

	vi.unstubAllGlobals()
})
