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
		appId: null,
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
	listAppSecretsByAppIds: vi.fn(async () => []),
	resolveSecret: vi.fn(async () => ({ found: false, value: null })),
	deleteSecret: vi.fn(async () => false),
	setSecretAllowedCapabilities: vi.fn(async () => undefined),
	setSecretAllowedPackages: vi.fn(async () => undefined),
	getValue: vi.fn(async () => null),
	logAuditEvent: vi.fn(async () => undefined),
	getRequestIp: vi.fn(() => null),
	dbFindOne: vi.fn(async () => null),
	verifyPassword: vi.fn(async () => false),
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
	buildSecretHostApprovalUrl: (...args: Array<unknown>) =>
		mockModule.buildSecretHostApprovalUrl(...args),
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
	setSecretAllowedPackages: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedPackages(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
	saveValue: (...args: Array<unknown>) => mockModule.saveValue(...args),
}))

vi.mock('#app/audit-log.ts', () => ({
	logAuditEvent: (...args: Array<unknown>) =>
		mockModule.logAuditEvent(...args),
	getRequestIp: (...args: Array<unknown>) => mockModule.getRequestIp(...args),
}))

vi.mock('#worker/db.ts', () => ({
	createDb: () => ({
		findOne: (...args: Array<unknown>) => mockModule.dbFindOne(...args),
	}),
	usersTable: 'users',
}))

vi.mock('@kody-internal/shared/password-hash.ts', () => ({
	verifyPassword: (...args: Array<unknown>) =>
		mockModule.verifyPassword(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

const { createAccountSecretsApiHandler, createAccountSecretRevealHandler } =
	await import('./account-secrets.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

test('connect oauth returns direct host approval links for saved token secrets', async () => {
	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
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
		connectorName: 'GitHub',
	})
	expect(mockModule.buildSecretHostApprovalUrl).toHaveBeenCalledTimes(4)
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
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
	const response = await handler.handler({
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
	expect(mockModule.buildSecretHostApprovalUrl).not.toHaveBeenCalled()
})

test('host approval view is derived from allowed-host and selected secret', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'cloudflareToken',
			scope: 'user',
			description: 'Cloudflare token',
			appId: null,
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
			appId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::cloudflareToken&allowed-host=API.Cloudflare.com',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		approval: {
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: 'api.cloudflare.com',
			requestedPackageId: null,
			currentAllowedHosts: [],
		},
	})
})

test('host approval approve persists host from allowed-host and selected secret', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'cloudflareToken',
			scope: 'user',
			description: 'Cloudflare token',
			appId: null,
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
	mockModule.listAppSecretsByAppIds.mockResolvedValueOnce(new Map())

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
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

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'cloudflareToken',
			scope: 'user',
			allowedHosts: ['api.github.com', 'api.cloudflare.com'],
			storageContext: { appId: null, sessionId: null },
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

test('account secrets payload preserves app titles and allowed packages', async () => {
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
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
	mockModule.listSecrets.mockResolvedValueOnce([
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
	mockModule.listAppSecretsByAppIds.mockResolvedValueOnce(
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
				scope: 'app',
				appTitle: '@kentcdodds/discord-gateway',
			}),
		]),
	})
})

test('package approval reject succeeds even when the secret no longer exists', async () => {
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listSecrets.mockResolvedValueOnce([])
	mockModule.listAppSecretsByAppIds.mockResolvedValueOnce(new Map())

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
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

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		secrets: [],
	})
	expect(mockModule.setSecretAllowedHosts).not.toHaveBeenCalled()
	expect(mockModule.setSecretAllowedCapabilities).not.toHaveBeenCalled()
})

test('package approval approve deduplicates allowed package ids', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'discordBotToken',
			scope: 'user',
			description: 'Discord bot token',
			appId: null,
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
	mockModule.listAppSecretsByAppIds.mockResolvedValueOnce(new Map())

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
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

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({ ok: true })
	expect(mockModule.setSecretAllowedPackages).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'discordBotToken',
			scope: 'user',
			allowedPackages: ['pkg-allowed', 'pkg-new'],
		}),
	)
})

test('GET /account/secrets.json includes decrypted value in selectedSecret', async () => {
	mockModule.listSecrets.mockResolvedValueOnce([
		{
			name: 'myApiKey',
			scope: 'user',
			description: 'API key',
			appId: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mockModule.listAppSecretsByAppIds.mockResolvedValueOnce(new Map())
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'the-actual-secret-value',
	})

	const handler = createAccountSecretsApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/secrets.json?selected=user::::myApiKey',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.ok).toBe(true)
	expect(payload.selectedSecret).toBeDefined()
	expect(payload.selectedSecret.name).toBe('myApiKey')
	expect(payload.selectedSecret.value).toBe('the-actual-secret-value')
	expect(mockModule.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'myApiKey',
			scope: 'user',
			storageContext: { appId: null, sessionId: null },
		}),
	)
})

test('POST /account/secrets/reveal without password returns 401', async () => {
	const handler = createAccountSecretRevealHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/secrets/reveal', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ secretId: 'user::::myApiKey' }),
		}),
	})

	expect(response.status).toBe(401)
	const payload = await response.json()
	expect(payload.ok).toBe(false)
})

test('POST /account/secrets/reveal with wrong password returns 401', async () => {
	mockModule.dbFindOne.mockResolvedValueOnce({
		id: 42,
		email: 'user@example.com',
		password_hash:
			'pbkdf2_sha256$100000$0000000000000000$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	})
	mockModule.verifyPassword.mockResolvedValueOnce(false)

	const handler = createAccountSecretRevealHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/secrets/reveal', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				secretId: 'user::::myApiKey',
				password: 'wrong-password',
			}),
		}),
	})

	expect(response.status).toBe(401)
	const payload = await response.json()
	expect(payload.ok).toBe(false)
	expect(payload.error).toBe('Invalid password.')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'secret_reveal',
			result: 'failure',
			reason: 'invalid_password',
		}),
	)
})

test('POST /account/secrets/reveal with valid reauth returns plaintext and writes audit log', async () => {
	mockModule.dbFindOne.mockResolvedValueOnce({
		id: 42,
		email: 'user@example.com',
		password_hash:
			'pbkdf2_sha256$100000$0000000000000000$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	})
	mockModule.verifyPassword.mockResolvedValueOnce(true)
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'the-actual-secret-value',
	})

	const handler = createAccountSecretRevealHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/secrets/reveal', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				secretId: 'user::::myApiKey',
				password: 'correct-password',
			}),
		}),
	})

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	const payload = await response.json()
	expect(payload.ok).toBe(true)
	expect(payload.value).toBe('the-actual-secret-value')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'secret_reveal',
			result: 'success',
		}),
	)
})
