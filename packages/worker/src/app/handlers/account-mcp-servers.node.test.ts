import { expect, test, vi } from 'vitest'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as ProviderMarks from '#worker/integrations/provider-marks.ts'

const mockModule = vi.hoisted(() => {
	const epoch = new Date(0).toISOString()
	const setting = (overrides: Record<string, unknown> = {}) => ({
		id: 'server-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		enabled: true,
		createdAt: epoch,
		updatedAt: epoch,
		usageMode: 'any' as const,
		allowedPackageIds: [] as Array<string>,
		...overrides,
	})
	const mcpUser = {
		userId: 'stable-user-1',
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	}
	return {
		epoch,
		waitUntil: vi.fn(),
		readAuthenticatedAppUser: vi.fn(async () => ({
			sessionUserId: '42',
			userId: 42,
			username: 'test-user',
			email: 'user@example.com',
			displayName: 'user',
			artifactOwnerIds: [],
			mcpUser,
		})),
		readAuthSessionResult: vi.fn(async () => ({
			session: { userId: '42' },
			setCookie: null,
		})),
		listMcpServerSettings: vi.fn(async () => [setting()]),
		getMcpServerSettingById: vi.fn(async () => setting()),
		addMcpServer: vi.fn(async () => ({
			setting: setting({
				id: 'server-2',
				name: 'notion',
				url: 'https://mcp.notion.example/mcp',
			}),
			connection: {
				serverId: 'server-2',
				state: 'authenticating',
				authUrl: 'https://auth.example.com/authorize?state=abc',
				error: null,
				toolCount: 0,
			},
		})),
		setMcpServerEnabled: vi.fn(async () => setting({ enabled: false })),
		setMcpServerUsage: vi.fn(async () =>
			setting({ usageMode: 'packages', allowedPackageIds: ['pkg-drafts'] }),
		),
		deleteMcpServer: vi.fn(async () => true),
		setMcpServerLastError: vi.fn(async () => true),
		persistMcpServerLastErrorIfChanged: vi.fn(async () => undefined),
		getCachedMcpClientHubSnapshot: vi.fn(async () => ({
			servers: [
				{
					serverId: 'server-1',
					name: 'linear',
					url: 'https://mcp.example.com/mcp',
					state: 'ready',
					authUrl: null,
					error: null,
					instructions: null,
					tools: [
						{ name: 'create_issue', inputSchema: { type: 'object' } },
						{ name: 'list_issues', inputSchema: { type: 'object' } },
					],
				},
			],
		})),
		handleOAuthCallback: vi.fn(async () => ({
			serverId: 'server-1',
			authSuccess: true,
			authError: null,
			serverName: 'linear',
			authorizationNeeded: false,
			lastError: null,
		})),
		reconnectServer: vi.fn(async () => ({
			serverId: 'server-1',
			state: 'authenticating',
			authUrl: 'https://auth.example.com/authorize?state=fresh.server-1',
			error: null,
			toolCount: 0,
		})),
	}
})

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		waitUntil: (...args: Array<unknown>) => mockModule.waitUntil(...args),
	}
})

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
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listMcpServerSettings: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettings(...args),
	getMcpServerSettingById: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingById(...args),
	addMcpServer: (...args: Array<unknown>) => mockModule.addMcpServer(...args),
	setMcpServerEnabled: (...args: Array<unknown>) =>
		mockModule.setMcpServerEnabled(...args),
	setMcpServerUsage: (...args: Array<unknown>) =>
		mockModule.setMcpServerUsage(...args),
	deleteMcpServer: (...args: Array<unknown>) =>
		mockModule.deleteMcpServer(...args),
	setMcpServerLastError: (...args: Array<unknown>) =>
		mockModule.setMcpServerLastError(...args),
	persistMcpServerLastErrorIfChanged: (...args: Array<unknown>) =>
		mockModule.persistMcpServerLastErrorIfChanged(...args),
	resolveMcpServerOAuthClientUrls: (input: {
		env: { APP_BASE_URL?: string | null }
		requestUrl?: string | URL | null
	}) => {
		const configured = input.env.APP_BASE_URL?.trim()
		const clientOrigin = configured
			? new URL(configured).origin
			: new URL(String(input.requestUrl ?? 'https://heykody.app')).origin
		return {
			clientOrigin,
			callbackUrl: `${clientOrigin}/account/mcp-servers/oauth/callback`,
			clientMetadataUrl: clientOrigin.startsWith('https:')
				? `${clientOrigin}/oauth/client-metadata.json`
				: null,
		}
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: async () => [
		{ id: 'pkg-drafts', kodyId: 'gmail-drafts' },
	],
}))

vi.mock('#worker/integrations/provider-marks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof ProviderMarks>()
	return {
		...actual,
		listPlatformProviderMarks: async () => [],
	}
})

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	getCachedMcpClientHubSnapshot: (...args: Array<unknown>) =>
		mockModule.getCachedMcpClientHubSnapshot(...args),
	createMcpClientHubClient: () => ({
		handleOAuthCallback: (...args: Array<unknown>) =>
			mockModule.handleOAuthCallback(...args),
		reconnectServer: (...args: Array<unknown>) =>
			mockModule.reconnectServer(...args),
		refreshServer: vi.fn(async () => ({
			serverId: 'server-1',
			state: 'ready',
			authUrl: null,
			error: null,
			toolCount: 2,
		})),
	}),
}))

const {
	createAccountMcpServersApiHandler,
	createAccountMcpServersOauthCallbackHandler,
} = await import('./account-mcp-servers.ts')

const env = { APP_DB: {} as D1Database } as Env
const apiUrl = 'https://example.com/account/mcp-servers.json'
const callbackUrl = 'https://example.com/account/mcp-servers/oauth/callback'
const userScope = { userId: 'stable-user-1', id: 'server-1' }

function discoveryFailure(attemptId: string, suffix = '') {
	const message = `Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, mcp https://mcp.example.com/mcp, id ${attemptId}).${suffix}`
	return {
		message,
		lastError: {
			message,
			phase: 'server/discover',
			httpStatus: null,
			httpBodySnippet: null,
			mcpEndpoint: 'https://mcp.example.com/mcp',
			resource: null,
			authServer: null,
			attemptId,
			at: '2026-09-08T00:00:00.000Z',
		},
	}
}

function createApiClient() {
	const { handler } = createAccountMcpServersApiHandler(env)
	return {
		get: () => handler({ request: new Request(apiUrl), params: {} } as never),
		post: (body: Record<string, unknown>) =>
			handler({
				request: new Request(apiUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				params: {},
			} as never),
	}
}

function createCallbackClient() {
	const { handler } = createAccountMcpServersOauthCallbackHandler(env)
	return async (search: string, init?: RequestInit) => {
		const response = await handler({
			request: new Request(`${callbackUrl}?${search}`, init),
			params: {},
		} as never)
		return {
			response,
			location: new URL(response.headers.get('Location') ?? '', callbackUrl),
		}
	}
}

test('MCP servers API lists, adds, reconnects, disables, and deletes with user scope', async () => {
	const { get, post } = createApiClient()

	const listResponse = await get()
	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	await expect(listResponse.json()).resolves.toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		oauthClientOrigin: 'https://example.com',
		oauthCallbackUrl: callbackUrl,
		oauthClientMetadataUrl: 'https://example.com/oauth/client-metadata.json',
		servers: [
			{
				id: 'server-1',
				name: 'linear',
				url: 'https://mcp.example.com/mcp',
				enabled: true,
				state: 'ready',
				connected: true,
				toolCount: 2,
				authUrl: null,
				error: null,
				hasRefreshToken: false,
				tools: ['create_issue', 'list_issues'],
				createdAt: mockModule.epoch,
				updatedAt: mockModule.epoch,
				autoLogoPath: null,
				catalogLogoPath: null,
				usageMode: 'any',
				allowedPackageIds: [],
			},
		],
		savedPackages: [{ id: 'pkg-drafts', kodyId: 'gmail-drafts' }],
	})

	const addResponse = await post({
		action: 'add',
		name: 'notion',
		url: 'https://mcp.notion.example/mcp',
		bearerToken: 'secret-token',
	})
	expect(addResponse.status).toBe(200)
	expect(mockModule.addMcpServer).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'notion',
			url: 'https://mcp.notion.example/mcp',
			baseUrl: 'https://example.com',
			bearerToken: 'secret-token',
			waitUntil: expect.any(Function),
		}),
	)
	await expect(addResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedServerId: 'server-2',
	})

	const reconnectResponse = await post({ action: 'reconnect', id: 'server-1' })
	expect(reconnectResponse.status).toBe(200)
	expect(mockModule.reconnectServer).toHaveBeenCalledWith({
		serverId: 'server-1',
		callbackUrl,
	})

	const hung = discoveryFailure('attempt-reconnect')
	mockModule.reconnectServer.mockResolvedValueOnce({
		serverId: 'server-1',
		state: 'connected',
		authUrl: null,
		error: hung.message,
		toolCount: 0,
		lastError: hung.lastError,
	})
	const hungReconnect = await post({ action: 'reconnect', id: 'server-1' })
	expect(hungReconnect.status).toBe(200)
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({
			...userScope,
			lastError: expect.objectContaining({
				phase: 'server/discover',
				attemptId: 'attempt-reconnect',
			}),
		}),
	)

	const disableResponse = await post({
		action: 'set-enabled',
		id: 'server-1',
		enabled: false,
	})
	expect(disableResponse.status).toBe(200)
	expect(mockModule.setMcpServerEnabled).toHaveBeenCalledWith(
		expect.objectContaining({ ...userScope, enabled: false }),
	)

	const usageResponse = await post({
		action: 'set-usage',
		id: 'server-1',
		usageMode: 'packages',
		allowedPackageIds: ['pkg-drafts'],
	})
	expect(usageResponse.status).toBe(200)
	expect(mockModule.setMcpServerUsage).toHaveBeenCalledWith(
		expect.objectContaining({
			...userScope,
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
		}),
	)

	const deleteResponse = await post({ action: 'delete', id: 'server-1' })
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deleteMcpServer).toHaveBeenCalledWith(
		expect.objectContaining(userScope),
	)
})

test('MCP servers OAuth callback ignores HEAD and redirects with the auth outcome', async () => {
	const callback = createCallbackClient()

	const head = await callback('code=abc&state=xyz', { method: 'HEAD' })
	expect(head.response.status).toBe(200)
	expect(mockModule.handleOAuthCallback).not.toHaveBeenCalled()

	const success = await callback('code=abc&state=xyz')
	expect(success.response.status).toBe(303)
	expect(success.location.pathname).toBe('/account/mcp-servers/server-1')
	expect(success.location.searchParams.get('auth')).toBe('success')
	expect(success.location.searchParams.get('server')).toBe('linear')
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({ ...userScope, lastError: null }),
	)

	const onboarding = await callback('code=abc&state=xyz', {
		headers: { Cookie: 'kody_mcp_oauth_return=onboarding' },
	})
	expect(onboarding.response.status).toBe(303)
	expect(onboarding.location.pathname).toBe('/onboarding/step-2')
	expect(onboarding.location.hash).toBe('')
	expect(onboarding.location.searchParams.get('auth')).toBe('success')
	const onboardingSetCookie =
		onboarding.response.headers.get('Set-Cookie') ?? ''
	expect(onboardingSetCookie).toContain('kody_mcp_oauth_return=;')
	expect(onboardingSetCookie).toContain('Max-Age=0')
	expect(mockModule.handleOAuthCallback).toHaveBeenCalledWith({
		url: `${callbackUrl}?code=abc&state=xyz`,
		callbackUrl,
	})

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: null,
		authSuccess: false,
		authError: 'Invalid state.',
		serverName: null,
		authorizationNeeded: false,
	})
	const failure = await callback('error=access_denied')
	expect(failure.response.status).toBe(303)
	expect(failure.location.pathname).toBe('/account/mcp-servers')
	expect(failure.location.searchParams.get('auth')).toBe('error')
	expect(failure.location.searchParams.get('reason')).toBe('Invalid state.')

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: 'Invalid origin uri https://example.com',
		serverName: 'linear',
		authorizationNeeded: false,
	})
	const originFailure = await callback('error=invalid_origin')
	expect(originFailure.response.status).toBe(303)
	expect(originFailure.location.searchParams.get('auth')).toBe('error')
	expect(originFailure.location.searchParams.get('reason')).toContain(
		'https://example.com/oauth/client-metadata.json',
	)

	const authorizationNeeded =
		'Authorization needed. Reconnect the MCP server and approve access once more.'
	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: authorizationNeeded,
		serverName: 'linear',
		authorizationNeeded: true,
	})
	const recovery = await callback('code=abc&state=used.server-1')
	expect(recovery.response.status).toBe(303)
	expect(recovery.location.pathname).toBe('/account/mcp-servers/server-1')
	expect(recovery.location.searchParams.get('auth')).toBe('required')
	expect(recovery.location.searchParams.has('reason')).toBe(false)

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: null,
		authSuccess: false,
		authError: authorizationNeeded,
		serverName: null,
		authorizationNeeded: true,
	})
	const unknownRecovery = await callback('error=access_denied')
	expect(unknownRecovery.location.pathname).toBe('/account/mcp-servers')
	expect(unknownRecovery.location.searchParams.get('auth')).toBe('retry')
	expect(unknownRecovery.location.searchParams.has('reason')).toBe(false)

	const settle = discoveryFailure(
		'attempt-1',
		' Reconnect it from /account/mcp-servers.',
	)
	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: settle.message,
		serverName: 'linear',
		authorizationNeeded: false,
		lastError: settle.lastError,
	})
	const settleFailure = await callback('code=abc&state=ok.server-1')
	expect(settleFailure.location.searchParams.get('auth')).toBe('error')
	expect(settleFailure.location.searchParams.get('reason')).toContain(
		"tool discovery didn't finish",
	)
	expect(mockModule.setMcpServerLastError).toHaveBeenCalledWith(
		expect.objectContaining({
			...userScope,
			lastError: expect.objectContaining({
				phase: 'server/discover',
				attemptId: 'attempt-1',
			}),
		}),
	)
})
