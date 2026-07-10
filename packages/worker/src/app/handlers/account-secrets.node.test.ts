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

vi.mock('#app/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#mcp/secrets/allowed-hosts.ts', () => ({
	normalizeAllowedHosts: (hosts: Array<string>) =>
		Array.from(
			new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean)),
		),
}))

vi.mock('#mcp/secrets/allowed-capabilities.ts', () => ({
	normalizeAllowedCapabilities: (capabilities: Array<string>) => capabilities,
}))

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

test('connect oauth saves tokens, integration metadata, and host approval links', async () => {
	mockModule.saveValue.mockClear()
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
				clientIdValueName: 'github-client-id',
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
	})
	expect(mockModule.buildSecretHostApprovalUrl).toHaveBeenCalledTimes(4)
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({
			name: '_integration:github',
			value: JSON.stringify({
				name: 'github',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'pkce',
				clientIdValueName: 'github-client-id',
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

	mockModule.saveValue.mockClear()
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
				clientIdValueName: 'spotify-client-id',
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
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({
			name: '_integration:spotify',
			value: expect.stringContaining(
				'"refreshTokenSecretName":"spotifyRefreshToken"',
			),
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
				clientIdValueName: 'tesla-client-id',
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
	mockModule.saveValue.mockClear()

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
					clientIdValueName: 'github-client-id',
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
	expect(mockModule.saveValue).not.toHaveBeenCalled()
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
			allowedHosts: ['api.github.com', 'api.cloudflare.com'],
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

test('package approval reject and approve handle missing secrets and deduplicate package ids', async () => {
	const handler = createAccountSecretsApiHandler(createEnv())

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
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
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
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
				clientIdValueName: 'canva-client-id',
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
	await expect(canvaResponse.json()).resolves.toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		integrationName: 'canva',
	})
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({
			name: '_integration:canva',
			value: JSON.stringify({
				name: 'canva',
				tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
				apiBaseUrl: 'https://api.canva.com/rest/v1',
				flow: 'confidential',
				usePkce: true,
				clientIdValueName: 'canva-client-id',
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
