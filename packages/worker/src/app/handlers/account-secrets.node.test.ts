import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: async () => ({
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
	}),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	getAppBaseUrl: () => 'https://example.com',
	saveSecret: vi.fn(async () => ({
		name: 'githubAccessToken',
		scope: 'user',
		description: '',
		appId: null,
		allowedHosts: [],
		allowedCapabilities: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		ttlMs: null,
	})),
	setSecretAllowedHosts: vi.fn(async () => undefined),
	saveValue: vi.fn(async () => undefined),
	createSecretHostApprovalToken: vi.fn(
		async (_env: unknown, input: { name: string; requestedHost: string }) => {
			return `token:${input.name}:${input.requestedHost}`
		},
	),
	buildSecretHostApprovalUrl: vi.fn(
		(input: { name: string; requestedHost: string; token: string }) =>
			`https://example.com/account/secrets/user/${input.name}?allowed-host=${input.requestedHost}&request=${input.token}`,
	),
	listSavedPackagesByUserId: vi.fn(async () => []),
	listSecrets: vi.fn(async () => []),
	listAppSecretsByAppIds: vi.fn(async () => []),
	resolveSecret: vi.fn(async () => null),
	deleteSecret: vi.fn(async () => false),
	setSecretAllowedCapabilities: vi.fn(async () => undefined),
	getValue: vi.fn(async () => null),
	verifySecretHostApprovalToken: vi.fn(async () => {
		throw new Error('not used')
	}),
	verifySecretPackageApprovalToken: vi.fn(async () => {
		throw new Error('not used')
	}),
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
	createSecretHostApprovalToken: (...args: Array<unknown>) =>
		mockModule.createSecretHostApprovalToken(...args),
	buildSecretHostApprovalUrl: (...args: Array<unknown>) =>
		mockModule.buildSecretHostApprovalUrl(...args),
	verifySecretHostApprovalToken: (...args: Array<unknown>) =>
		mockModule.verifySecretHostApprovalToken(...args),
}))

vi.mock('#mcp/secrets/package-approval.ts', () => ({
	verifySecretPackageApprovalToken: (...args: Array<unknown>) =>
		mockModule.verifySecretPackageApprovalToken(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	saveSecret: (...args: Array<unknown>) => mockModule.saveSecret(...args),
	setSecretAllowedHosts: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedHosts(...args),
	listSecrets: (...args: Array<unknown>) => mockModule.listSecrets(...args),
	listAppSecretsByAppIds: (...args: Array<unknown>) =>
		mockModule.listAppSecretsByAppIds(...args),
	resolveSecret: (...args: Array<unknown>) => mockModule.resolveSecret(...args),
	deleteSecret: (...args: Array<unknown>) => mockModule.deleteSecret(...args),
	setSecretAllowedCapabilities: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedCapabilities(...args),
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

test('connect oauth returns direct host approval links for saved token secrets', async () => {
	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.action({
		request: new Request('https://example.com/account/secrets.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'connect_oauth',
				provider: 'GitHub',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
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

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		allowedHosts: ['api.github.com', 'github.com'],
		hostApprovalLinks: [
			{
				secretName: 'githubAccessToken',
				host: 'api.github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubAccessToken?allowed-host=api.github.com&request=token:githubAccessToken:api.github.com',
			},
			{
				secretName: 'githubAccessToken',
				host: 'github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubAccessToken?allowed-host=github.com&request=token:githubAccessToken:github.com',
			},
			{
				secretName: 'githubRefreshToken',
				host: 'api.github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubRefreshToken?allowed-host=api.github.com&request=token:githubRefreshToken:api.github.com',
			},
			{
				secretName: 'githubRefreshToken',
				host: 'github.com',
				approvalUrl:
					'https://example.com/account/secrets/user/githubRefreshToken?allowed-host=github.com&request=token:githubRefreshToken:github.com',
			},
		],
		connectorName: 'GitHub',
	})
	expect(mockModule.createSecretHostApprovalToken).toHaveBeenCalledTimes(4)
	expect(mockModule.createSecretHostApprovalToken).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ COOKIE_SECRET: 'secret' }),
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'githubAccessToken',
			scope: 'user',
			requestedHost: 'api.github.com',
			storageContext: null,
		}),
	)
	expect(mockModule.createSecretHostApprovalToken).toHaveBeenNthCalledWith(
		4,
		expect.objectContaining({ COOKIE_SECRET: 'secret' }),
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'githubRefreshToken',
			scope: 'user',
			requestedHost: 'github.com',
			storageContext: null,
		}),
	)
	expect(mockModule.setSecretAllowedHosts).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'githubAccessToken',
			scope: 'user',
			allowedHosts: ['api.github.com', 'github.com'],
			storageContext: { sessionId: null, appId: null },
		}),
	)
	expect(mockModule.setSecretAllowedHosts).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'githubRefreshToken',
			scope: 'user',
			allowedHosts: ['api.github.com', 'github.com'],
			storageContext: { sessionId: null, appId: null },
		}),
	)
})

test('connect oauth omits direct host approval links when hosts are already approved', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'teslaAccessToken',
			scope: 'user',
			description: '',
			appId: null,
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
			appId: null,
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

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.action({
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

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toMatchObject({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: true,
		hostApprovalLinks: [],
		connectorName: 'Tesla',
	})
	expect(payload.allowedHosts).toEqual(
		expect.arrayContaining([
			'auth.tesla.com',
			'fleet-api.prd.na.vn.cloud.tesla.com',
			'fleet-auth.prd.vn.cloud.tesla.com',
		]),
	)
	expect(mockModule.createSecretHostApprovalToken).not.toHaveBeenCalled()
})

test('account secrets payload preserves app titles and allowed packages', async () => {
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'app-123',
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
	mockModule.listSecrets.mockResolvedValue([
		{
			name: 'discordBotToken',
			scope: 'user',
			description: 'Discord bot token',
			appId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: ['pkg-allowed'],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listAppSecretsByAppIds.mockResolvedValue(
		new Map([
			[
				'app-123',
				[
					{
						name: 'gatewaySigningSecret',
						scope: 'app',
						description: 'Gateway signing secret',
						appId: 'app-123',
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
	const response = await handler.action({
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
				allowedPackages: [
					{
						packageId: 'pkg-allowed',
						kodyId: 'discord-general-chat',
						name: '@kentcdodds/discord-general-chat',
					},
				],
			}),
			expect.objectContaining({
				name: 'gatewaySigningSecret',
				scope: 'app',
				appTitle: '@kentcdodds/discord-gateway',
			}),
		]),
	})
})
