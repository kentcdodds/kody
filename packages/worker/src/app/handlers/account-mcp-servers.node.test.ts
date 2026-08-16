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
	readAuthSessionResult: vi.fn(async () => ({
		session: { userId: '42' },
		setCookie: null,
	})),
	listMcpServerSettings: vi.fn(async () => [
		{
			id: 'server-1',
			name: 'linear',
			url: 'https://mcp.example.com/mcp',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
	getMcpServerSettingById: vi.fn(async () => ({
		id: 'server-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		enabled: true,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	addMcpServer: vi.fn(async () => ({
		setting: {
			id: 'server-2',
			name: 'notion',
			url: 'https://mcp.notion.example/mcp',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
		connection: {
			serverId: 'server-2',
			state: 'authenticating',
			authUrl: 'https://auth.example.com/authorize?state=abc',
			error: null,
			toolCount: 0,
		},
	})),
	setMcpServerEnabled: vi.fn(async () => ({
		id: 'server-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		enabled: false,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	deleteMcpServer: vi.fn(async () => true),
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
	})),
	reconnectServer: vi.fn(async () => ({
		serverId: 'server-1',
		state: 'authenticating',
		authUrl: 'https://auth.example.com/authorize?state=fresh.server-1',
		error: null,
		toolCount: 0,
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
	deleteMcpServer: (...args: Array<unknown>) =>
		mockModule.deleteMcpServer(...args),
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
		}
	},
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	getCachedMcpClientHubSnapshot: (...args: Array<unknown>) =>
		mockModule.getCachedMcpClientHubSnapshot(...args),
	createMcpClientHubClient: () => ({
		handleOAuthCallback: (...args: Array<unknown>) =>
			mockModule.handleOAuthCallback(...args),
		reconnectServer: (...args: Array<unknown>) =>
			mockModule.reconnectServer(...args),
	}),
}))

const {
	createAccountMcpServersApiHandler,
	createAccountMcpServersOauthCallbackHandler,
} = await import('./account-mcp-servers.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

test('MCP servers API lists servers with live hub status', async () => {
	const handler = createAccountMcpServersApiHandler(createEnv())

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers.json'),
		params: {},
	} as never)

	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	await expect(listResponse.json()).resolves.toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		oauthClientOrigin: 'https://example.com',
		oauthCallbackUrl: 'https://example.com/account/mcp-servers/oauth/callback',
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
				tools: ['create_issue', 'list_issues'],
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		],
	})
})

test('MCP servers API add action uses the canonical OAuth callback origin', async () => {
	const handler = createAccountMcpServersApiHandler(createEnv())

	const addResponse = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'add',
				name: 'notion',
				url: 'https://mcp.notion.example/mcp',
				bearerToken: 'secret-token',
			}),
		}),
		params: {},
	} as never)

	expect(addResponse.status).toBe(200)
	expect(mockModule.addMcpServer).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			name: 'notion',
			url: 'https://mcp.notion.example/mcp',
			baseUrl: 'https://example.com',
			bearerToken: 'secret-token',
		}),
	)
	const payload = (await addResponse.json()) as {
		ok: boolean
		selectedServerId?: string
	}
	expect(payload.ok).toBe(true)
	expect(payload.selectedServerId).toBe('server-2')
})

test('MCP servers API reconnect uses the current callback and starts fresh authorization', async () => {
	const handler = createAccountMcpServersApiHandler(createEnv())

	const reconnectResponse = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'reconnect', id: 'server-1' }),
		}),
		params: {},
	} as never)

	expect(reconnectResponse.status).toBe(200)
	expect(mockModule.reconnectServer).toHaveBeenCalledWith({
		serverId: 'server-1',
		callbackUrl: 'https://example.com/account/mcp-servers/oauth/callback',
	})
})

test('MCP servers API set-enabled and delete actions are user-scoped', async () => {
	const handler = createAccountMcpServersApiHandler(createEnv())

	const disableResponse = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'set-enabled',
				id: 'server-1',
				enabled: false,
			}),
		}),
		params: {},
	} as never)
	expect(disableResponse.status).toBe(200)
	expect(mockModule.setMcpServerEnabled).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			id: 'server-1',
			enabled: false,
		}),
	)

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id: 'server-1' }),
		}),
		params: {},
	} as never)
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deleteMcpServer).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			id: 'server-1',
		}),
	)
})

test('MCP servers OAuth callback redirects with the auth outcome', async () => {
	const handler = createAccountMcpServersOauthCallbackHandler(createEnv())

	const successResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/mcp-servers/oauth/callback?code=abc&state=xyz',
		),
		params: {},
	} as never)
	expect(successResponse.status).toBe(303)
	const successLocation = new URL(successResponse.headers.get('Location') ?? '')
	expect(successLocation.pathname).toBe('/account/mcp-servers/server-1')
	expect(successLocation.searchParams.get('auth')).toBe('success')
	expect(successLocation.searchParams.get('server')).toBe('linear')
	expect(mockModule.handleOAuthCallback).toHaveBeenCalledWith({
		url: 'https://example.com/account/mcp-servers/oauth/callback?code=abc&state=xyz',
		callbackUrl: 'https://example.com/account/mcp-servers/oauth/callback',
	})

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: null,
		authSuccess: false,
		authError: 'Invalid state.',
		serverName: null,
		authorizationNeeded: false,
	})
	const failureResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/mcp-servers/oauth/callback?error=access_denied',
		),
		params: {},
	} as never)
	expect(failureResponse.status).toBe(303)
	const failureLocation = new URL(failureResponse.headers.get('Location') ?? '')
	expect(failureLocation.pathname).toBe('/account/mcp-servers')
	expect(failureLocation.searchParams.get('auth')).toBe('error')
	expect(failureLocation.searchParams.get('reason')).toBe('Invalid state.')

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: 'Invalid origin uri https://example.com',
		serverName: 'linear',
		authorizationNeeded: false,
	})
	const originFailureResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/mcp-servers/oauth/callback?error=invalid_origin',
		),
		params: {},
	} as never)
	expect(originFailureResponse.status).toBe(303)
	const originFailureLocation = new URL(
		originFailureResponse.headers.get('Location') ?? '',
	)
	expect(originFailureLocation.searchParams.get('auth')).toBe('error')
	expect(originFailureLocation.searchParams.get('reason')).toContain(
		'Invalid origin uri https://example.com',
	)
	expect(originFailureLocation.searchParams.get('reason')).toContain(
		'/account/mcp-servers/oauth/callback',
	)

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError: 'Authorization completed, but no authorization link.',
		serverName: 'linear',
		authorizationNeeded: false,
	})
	const incompleteResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/mcp-servers/oauth/callback?code=abc&state=xyz.server-1',
		),
		params: {},
	} as never)
	expect(incompleteResponse.status).toBe(303)
	const incompleteLocation = new URL(
		incompleteResponse.headers.get('Location') ?? '',
	)
	expect(incompleteLocation.pathname).toBe('/account/mcp-servers/server-1')
	expect(incompleteLocation.searchParams.get('auth')).toBe('error')
	expect(incompleteLocation.searchParams.get('reason')).toContain(
		'no authorization link',
	)

	mockModule.handleOAuthCallback.mockResolvedValueOnce({
		serverId: 'server-1',
		authSuccess: false,
		authError:
			'Authorization needed. Reconnect the MCP server and approve access once more.',
		serverName: 'linear',
		authorizationNeeded: true,
	})
	const recoveryResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/mcp-servers/oauth/callback?code=abc&state=used.server-1',
		),
		params: {},
	} as never)
	expect(recoveryResponse.status).toBe(303)
	const recoveryLocation = new URL(
		recoveryResponse.headers.get('Location') ?? '',
	)
	expect(recoveryLocation.pathname).toBe('/account/mcp-servers/server-1')
	expect(recoveryLocation.searchParams.get('auth')).toBe('required')
	expect(recoveryLocation.searchParams.has('reason')).toBe(false)
})
