import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'

type FakeServerRow = {
	id: string
	name: string
	server_url: string
	callback_url: string
	client_id: string | null
	auth_url: string | null
	server_options: string | null
}

type FakeConnection = {
	connectionState: string
	connectionError: string | null
	instructions: string | null
	tools: Array<never>
	options: {
		client: Record<string, unknown>
		transport: {
			type: string
			headers?: Record<string, string>
			sessionId?: string
			protocolVersion?: string
			authProvider: {
				serverId: string
				clientId?: string
				authUrl?: string
				redirectUrl: string
				storedTokens?: {
					access_token?: string
					refresh_token?: string
				} | null
				tokens?: () => Promise<unknown>
			}
		}
	}
}

type FakeManager = {
	rows: Array<FakeServerRow>
	mcpConnections: Record<string, FakeConnection>
	connectCount: number
	registerCount: number
	discoverCount: number
	discoverSucceedsOn: 'never' | 'always' | 'legacy'
	connectBehavior: 'oauth' | 'ready' | 'disconnected' | 'connected'
	connectBehaviors: Array<'oauth' | 'ready' | 'disconnected' | 'connected'>
	registerFailuresRemaining: number
	callbackMatches: boolean
	callbackResult: {
		serverId?: string
		authSuccess: boolean
		authError?: string
	}
}

const mockModule = vi.hoisted(() => ({
	manager: null as FakeManager | null,
}))

vi.mock('@sentry/cloudflare', () => ({
	instrumentDurableObjectWithSentry: (
		_factory: unknown,
		durableObjectClass: new (...args: Array<never>) => unknown,
	) => durableObjectClass,
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<CloudflareWorkers>()
	return {
		...actual,
		DurableObject: class {
			protected readonly ctx: DurableObjectState
			protected readonly env: Env

			constructor(ctx: DurableObjectState, env: Env) {
				this.ctx = ctx
				this.env = env
			}
		},
	}
})

vi.mock('agents/mcp/do-oauth-client-provider', () => ({
	DurableObjectOAuthClientProvider: class {
		serverId = ''
		clientId: string | undefined
		authUrl: string | undefined

		constructor(
			_storage: DurableObjectStorage,
			_clientName: string,
			readonly redirectUrl: string,
		) {}
	},
}))

vi.mock('agents/lifecycle', () => ({
	Lifecycle: class {
		static install() {
			return new this()
		}

		private capabilities: Array<{ onStart?: () => Promise<void> }> = []

		use(capability: { onStart?: () => Promise<void> }) {
			this.capabilities.push(capability)
			return this
		}

		async start() {
			for (const capability of this.capabilities) {
				await capability.onStart?.()
			}
		}
	},
}))

vi.mock('agents/mcp/client', () => ({
	MCPClientManager: class {
		rows: Array<FakeServerRow> = []
		mcpConnections: Record<string, FakeConnection> = {}
		connectCount = 0
		registerCount = 0
		discoverCount = 0
		discoverSucceedsOn: 'never' | 'always' | 'legacy' = 'never'
		connectBehavior: 'oauth' | 'ready' | 'disconnected' | 'connected' = 'oauth'
		connectBehaviors: Array<'oauth' | 'ready' | 'disconnected' | 'connected'> =
			[]
		registerFailuresRemaining = 0
		callbackMatches = true
		callbackResult = {
			serverId: 'server-1',
			authSuccess: false,
			authError: 'State not found or already used',
		}

		constructor() {
			mockModule.manager = this
		}

		async onStart() {}

		async waitForConnections() {}

		listServers() {
			return this.rows
		}

		async removeServer(serverId: string) {
			this.rows = this.rows.filter((row) => row.id !== serverId)
			delete this.mcpConnections[serverId]
		}

		async registerServer(
			serverId: string,
			options: {
				url: string
				name: string
				callbackUrl: string
				clientId?: string
				authUrl?: string
				client?: Record<string, unknown>
				transport: FakeConnection['options']['transport']
			},
		) {
			if (this.registerFailuresRemaining > 0) {
				this.registerFailuresRemaining -= 1
				throw new Error('Replacement registration failed.')
			}
			this.registerCount += 1
			this.rows.push({
				id: serverId,
				name: options.name,
				server_url: options.url,
				callback_url: options.callbackUrl,
				client_id: options.clientId ?? null,
				auth_url: options.authUrl ?? null,
				server_options: null,
			})
			this.mcpConnections[serverId] = {
				connectionState: 'disconnected',
				connectionError: null,
				instructions: null,
				tools: [],
				options: {
					client: options.client ?? {},
					transport: options.transport,
				},
			}
		}

		async establishConnection() {}

		async connectToServer(serverId: string) {
			this.connectCount += 1
			const connection = this.mcpConnections[serverId]
			if (!connection) throw new Error('Missing fake connection.')
			const provider = connection.options.transport.authProvider
			const connectBehavior =
				this.connectBehaviors.shift() ?? this.connectBehavior
			if (connectBehavior === 'ready') {
				connection.connectionState = 'ready'
				connection.connectionError = null
				return { state: 'connected' }
			}
			if (connectBehavior === 'connected') {
				connection.connectionState = 'connected'
				connection.connectionError = null
				return { state: 'connected' }
			}
			if (connectBehavior === 'disconnected') {
				connection.connectionState = 'disconnected'
				connection.connectionError = 'upstream closed'
				return { state: 'disconnected' }
			}
			if (provider.storedTokens) provider.storedTokens = null
			provider.clientId ??= `client-${this.connectCount}`
			provider.authUrl = `https://auth.example/authorize?state=fresh-${this.connectCount}.${serverId}&redirect_uri=${encodeURIComponent(provider.redirectUrl)}`
			connection.connectionState = 'authenticating'
			const row = this.rows.find((item) => item.id === serverId)
			if (!row) throw new Error('Missing fake server row.')
			row.client_id = provider.clientId
			row.auth_url = provider.authUrl
			return {
				state: 'authenticating',
				authUrl: provider.authUrl,
				clientId: provider.clientId,
			}
		}

		async discoverIfConnected(serverId: string) {
			this.discoverCount += 1
			const connection = this.mcpConnections[serverId]
			if (!connection) return
			const negotiation = Reflect.get(
				connection.options.client,
				'versionNegotiation',
			)
			const isLegacy =
				negotiation != null &&
				typeof negotiation === 'object' &&
				Reflect.get(negotiation, 'mode') === 'legacy'
			if (
				this.discoverSucceedsOn === 'always' ||
				(this.discoverSucceedsOn === 'legacy' && isLegacy)
			) {
				connection.connectionState = 'ready'
				connection.connectionError = null
			}
		}

		isCallbackRequest() {
			return this.callbackMatches
		}

		async handleCallbackRequest() {
			return this.callbackResult
		}
	},
}))

const { McpClientHub } = await import('./hub.ts')

function createDurableObjectState() {
	const values = new Map<string, unknown>()
	return {
		state: {
			storage: {
				sql: { exec: vi.fn(() => []) },
				put: vi.fn(
					async (
						keyOrEntries: string | Record<string, unknown>,
						value?: unknown,
					) => {
						if (typeof keyOrEntries === 'string') {
							values.set(keyOrEntries, value)
							return
						}
						for (const [key, entryValue] of Object.entries(keyOrEntries)) {
							values.set(key, entryValue)
						}
					},
				),
				get: vi.fn(async (key: string) => values.get(key)),
				list: vi.fn(async ({ prefix }: { prefix: string }) => {
					return new Map(
						[...values.entries()].filter(([key]) => key.startsWith(prefix)),
					)
				}),
				delete: vi.fn(async (keys: string | Array<string>) => {
					for (const key of Array.isArray(keys) ? keys : [keys]) {
						values.delete(key)
					}
				}),
			},
		} as unknown as DurableObjectState,
		values,
	}
}

function seedServer(input: {
	manager: FakeManager
	callbackUrl: string
	clientId: string
	authUrl: string
}) {
	const provider = {
		serverId: 'server-1',
		clientId: input.clientId,
		authUrl: input.authUrl,
		redirectUrl: input.callbackUrl,
		storedTokens: null as {
			access_token?: string
			refresh_token?: string
		} | null,
		async tokens() {
			return this.storedTokens ?? undefined
		},
	}
	input.manager.rows = [
		{
			id: 'server-1',
			name: 'mediarss',
			server_url: 'https://mediarss.example/mcp',
			callback_url: input.callbackUrl,
			client_id: input.clientId,
			auth_url: input.authUrl,
			server_options: null,
		},
	]
	input.manager.mcpConnections = {
		'server-1': {
			connectionState: 'authenticating',
			connectionError: null,
			instructions: null,
			tools: [],
			options: {
				client: {},
				transport: {
					type: 'auto',
					headers: { 'X-Test': 'preserved' },
					sessionId: 'stale-2025-session',
					protocolVersion: '2025-11-25',
					authProvider: provider,
				},
			},
		},
	}
}

async function seedReadyHomeServer(input: {
	hub: InstanceType<typeof McpClientHub>
	manager: FakeManager
}) {
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager: input.manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=ok.server-1',
	})
	const connection = input.manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'ready'
	input.manager.rows[0]!.name = 'home'
	await input.hub.getSnapshot()
	return { callbackUrl, connection }
}

test('reconnect repairs stale callbacks and always replaces pending OAuth state', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')

	const oldCallback = 'https://heykody.app/account/mcp-servers/oauth/callback'
	const currentCallback =
		'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl: oldCallback,
		clientId: 'stale-client',
		authUrl: 'https://auth.example/authorize?state=stale.server-1',
	})
	values.set('/Kody/server-1/stale-client/client_info/', {
		client_id: 'stale-client',
	})
	values.set('/Kody/server-1/state/stale', { serverId: 'server-1' })

	const repaired = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl: currentCallback,
	})
	const repairedRow = manager.rows[0]
	expect(repaired.state).toBe('authenticating')
	expect(repaired.authUrl).toContain('state=fresh-1.server-1')
	expect(repaired.authUrl).toContain(encodeURIComponent(currentCallback))
	expect(repairedRow?.callback_url).toBe(currentCallback)
	expect(repairedRow?.client_id).toBe('client-1')
	expect(repairedRow?.client_id).not.toBe('stale-client')
	expect(manager.mcpConnections['server-1']?.options.transport.headers).toEqual(
		{ 'X-Test': 'preserved' },
	)
	expect(
		manager.mcpConnections['server-1']?.options.transport.sessionId,
	).toBeUndefined()
	expect(
		manager.mcpConnections['server-1']?.options.transport.protocolVersion,
	).toBeUndefined()
	expect(manager.mcpConnections['server-1']?.options.client).toMatchObject({
		versionNegotiation: { mode: 'auto' },
	})
	expect([...values.keys()].filter((key) => key.startsWith('/Kody/'))).toEqual(
		[],
	)

	values.set('/Kody/server-1/client-1/client_info/', {
		client_id: 'client-1',
	})
	values.set('/Kody/server-1/state/fresh-1', { serverId: 'server-1' })
	const firstAuthUrl = repaired.authUrl
	const restarted = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl: currentCallback,
	})
	expect(restarted.authUrl).toContain('state=fresh-2.server-1')
	expect(restarted.authUrl).not.toBe(firstAuthUrl)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	expect(values.has('/Kody/server-1/client-1/client_info/')).toBe(true)
	expect(values.has('/Kody/server-1/state/fresh-1')).toBe(false)
})

test('failed replacement registration restores the saved server and OAuth state', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')

	const oldCallback = 'https://heykody.app/account/mcp-servers/oauth/callback'
	const currentCallback =
		'https://kody.codes/account/mcp-servers/oauth/callback'
	const oldAuthUrl = 'https://auth.example/authorize?state=stale.server-1'
	seedServer({
		manager,
		callbackUrl: oldCallback,
		clientId: 'stale-client',
		authUrl: oldAuthUrl,
	})
	const clientInfoKey = '/Kody/server-1/stale-client/client_info/'
	const stateKey = '/Kody/server-1/state/stale'
	values.set(clientInfoKey, { client_id: 'stale-client' })
	values.set(stateKey, { serverId: 'server-1' })
	manager.registerFailuresRemaining = 1

	await expect(
		hub.reconnectServer({
			serverId: 'server-1',
			callbackUrl: currentCallback,
		}),
	).rejects.toThrow('Replacement registration failed.')

	expect(manager.rows).toEqual([
		expect.objectContaining({
			id: 'server-1',
			callback_url: oldCallback,
			client_id: 'stale-client',
			auth_url: oldAuthUrl,
		}),
	])
	expect(manager.mcpConnections['server-1']?.options.transport.headers).toEqual(
		{ 'X-Test': 'preserved' },
	)
	expect(values.get(clientInfoKey)).toEqual({ client_id: 'stale-client' })
	expect(values.get(stateKey)).toEqual({ serverId: 'server-1' })
})

test('replayed unusable callbacks leave past-OAuth server credentials intact', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=used.server-1',
	})
	manager.callbackMatches = false
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	manager.rows[0]!.auth_url = null
	const tokenKey = '/Kody/server-1/client-1/token'
	values.set(tokenKey, { access_token: 'still-valid' })

	connection.connectionState = 'ready'
	const readyOutcome = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=used.server-1`,
		callbackUrl,
	})
	expect(readyOutcome).toEqual({
		serverId: 'server-1',
		authSuccess: true,
		authError: null,
		serverName: 'mediarss',
		authorizationNeeded: false,
		lastError: null,
	})
	expect(manager.connectCount).toBe(0)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	expect(values.get(tokenKey)).toEqual({ access_token: 'still-valid' })
})

test('used and missing callback states recover without exposing an internal state error', async () => {
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=used.server-1',
	})

	const usedState = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=used.server-1`,
		callbackUrl,
	})
	expect(usedState.authorizationNeeded).toBe(true)
	expect(usedState.authSuccess).toBe(false)
	expect(usedState.serverId).toBe('server-1')
	expect(usedState.authError).toBeTruthy()
	expect(usedState.authError).not.toContain('state')
	expect(manager.rows[0]?.auth_url).toContain('state=fresh-1.server-1')

	manager.callbackMatches = false
	const missingState = await hub.handleOAuthCallback({
		url: `${callbackUrl}?error=access_denied`,
		callbackUrl,
	})
	expect(missingState.authorizationNeeded).toBe(true)
	expect(missingState.serverId).toBe('server-1')
	expect(missingState.authError).not.toContain('state')
	expect(manager.rows[0]?.auth_url).toContain('state=fresh-2.server-1')
})

test('replayed unusable callback settles with stored tokens instead of reminting', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl, connection } = await seedReadyHomeServer({
		hub,
		manager,
	})
	connection.connectionState = 'authenticating'
	connection.connectionError =
		"This MCP server's stored access token is no longer usable and Kody has no refresh token to renew it"
	manager.rows[0]!.auth_url = null
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'fresh-at',
		refresh_token: 'fresh-rt',
	}
	values.set('mcp-oauth-token-recovery/server-1', {
		message: connection.connectionError,
		phase: 'token exchange',
		attemptId: 'stale-rt',
		at: '2026-09-14T00:00:00.000Z',
	})
	manager.callbackMatches = false
	manager.connectBehavior = 'ready'
	manager.registerCount = 0
	const outcome = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=used.server-1`,
		callbackUrl,
	})
	expect(outcome).toMatchObject({
		serverId: 'server-1',
		authSuccess: true,
		authorizationNeeded: false,
		lastError: null,
	})
	expect(manager.registerCount).toBe(0)
	expect(connection.options.transport.authProvider.storedTokens).toEqual({
		access_token: 'fresh-at',
		refresh_token: 'fresh-rt',
	})
	expect(values.has('mcp-oauth-token-recovery/server-1')).toBe(false)
	expect(connection.connectionState).toBe('ready')
})

test('successful OAuth callback drops a stale no-refresh-token lastError', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl, connection } = await seedReadyHomeServer({
		hub,
		manager,
	})
	values.set('mcp-oauth-token-recovery/server-1', {
		message:
			"This MCP server's stored access token is no longer usable and Kody has no refresh token to renew it",
		phase: 'token exchange',
		attemptId: 'stale-rt',
		at: '2026-09-14T00:00:00.000Z',
	})
	connection.connectionState = 'connected'
	connection.connectionError = null
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'new-at',
		refresh_token: 'new-rt',
	}
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
	manager.discoverSucceedsOn = 'always'
	const outcome = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=ok.server-1`,
		callbackUrl,
	})
	expect(outcome.authSuccess).toBe(true)
	expect(outcome.lastError).toBeNull()
	expect(values.has('mcp-oauth-token-recovery/server-1')).toBe(false)
	expect(connection.connectionState).toBe('ready')
})

test('first-time OAuth grant that stays authenticating does not emit disconnected', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=ok.server-1',
	})
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'authenticating'
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'new-at',
		refresh_token: 'new-rt',
	}
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
	await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=ok.server-1`,
		callbackUrl,
	})
	expect(connection.connectionState).toBe('authenticating')
	expect(await hub.peekConnectionEvents()).toEqual([])
	expect(values.has('mcp-connection-events-pending')).toBe(false)
	expect(values.get('mcp-connection-episode/server-1')).toMatchObject({
		wasReady: false,
		disconnectedEmitted: false,
	})
	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('authenticating')
	expect(peeked.servers[0]?.lastError ?? null).toBeNull()
	expect(await hub.peekConnectionEvents()).toEqual([])
})

test('peekServers returns cards without observing or reconnecting', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	const episodeBefore = values.get('mcp-connection-episode/server-1')
	connection.connectionState = 'disconnected'
	manager.connectCount = 0
	manager.connectBehavior = 'ready'

	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('disconnected')
	expect(manager.connectCount).toBe(0)
	expect(values.get('mcp-connection-episode/server-1')).toEqual(episodeBefore)
	expect(values.has('mcp-connection-events-pending')).toBe(false)
	expect(await hub.takeConnectionEvents()).toEqual([])
})

test('peekServers queues a disconnected episode when a ready server parks on token recovery so the hub client can dispatch it', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	connection.connectionState = 'authenticating'
	connection.connectionError = null
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'stale-at',
		refresh_token: 'still-rt',
	}
	manager.rows[0]!.auth_url =
		'https://auth.example/authorize?state=fresh.server-1'
	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('authenticating')
	expect(peeked.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(values.get('mcp-connection-episode/server-1')).toMatchObject({
		wasReady: true,
		disconnectedEmitted: true,
	})
	expect(await hub.peekConnectionEvents()).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'home',
		}),
	])
	expect(await hub.takeConnectionEvents()).toHaveLength(1)
})

test('ackConnectionEvents removes only the dispatched ids', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	connection.connectionState = 'authenticating'
	connection.connectionError = null
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'stale-at',
		refresh_token: 'still-rt',
	}
	manager.rows[0]!.auth_url =
		'https://auth.example/authorize?state=fresh.server-1'
	await hub.peekServers()
	const queued = await hub.peekConnectionEvents()
	expect(queued).toHaveLength(1)
	const firstId = queued[0]?.eventId
	expect(firstId).toBeTruthy()
	const laterEvent = {
		...queued[0]!,
		eventId: 'later-event',
		topic: 'mcp.server.reconnected' as const,
		state: 'ready' as const,
	}
	values.set('mcp-connection-events-pending', [...queued, laterEvent])
	await hub.ackConnectionEvents([firstId!])
	expect(await hub.peekConnectionEvents()).toEqual([laterEvent])
})

test('token-recovery park keeps lastError on a later peek while a refresh token is still stored', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	connection.connectionState = 'authenticating'
	connection.connectionError = null
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'stale-at',
		refresh_token: 'still-rt',
	}
	manager.rows[0]!.auth_url =
		'https://auth.example/authorize?state=fresh.server-1'
	const first = await hub.peekServers()
	expect(first.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(values.get('mcp-oauth-token-recovery/server-1')).toMatchObject({
		phase: 'token exchange',
	})
	const second = await hub.peekServers()
	expect(second.servers[0]?.state).toBe('authenticating')
	expect(second.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(second.servers[0]?.hasRefreshToken).toBe(true)
	expect(values.get('mcp-oauth-token-recovery/server-1')).toMatchObject({
		phase: 'token exchange',
	})
})

test('token-recovery park with no refresh token still emits disconnected when wasReady was never stored', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	seedServer({
		manager,
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=fresh.server-1',
	})
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'authenticating'
	connection.options.transport.authProvider.storedTokens = null
	expect(values.has('mcp-connection-episode/server-1')).toBe(false)

	const firstAdd = await hub.peekServers()
	expect(firstAdd.servers[0]?.state).toBe('authenticating')
	expect(firstAdd.servers[0]?.lastError).toBeNull()
	expect(values.has('mcp-connection-events-pending')).toBe(false)

	connection.options.transport.authProvider.storedTokens = {
		access_token: 'stale-at',
	}

	const peeked = await hub.peekServers()
	expect(peeked.servers[0]?.state).toBe('authenticating')
	expect(peeked.servers[0]?.lastError?.phase).toBe('token exchange')
	expect(peeked.servers[0]?.lastError?.message).toContain(
		'has no refresh token to renew',
	)
	expect(values.get('mcp-connection-episode/server-1')).toMatchObject({
		wasReady: true,
		disconnectedEmitted: true,
		lastObservedState: 'authenticating',
	})
	const downEvents = await hub.peekConnectionEvents()
	expect(downEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'mediarss',
			state: 'authenticating',
			previousState: 'ready',
		}),
	])
	const episodeId = downEvents[0]?.episodeId
	expect(episodeId).toBeTruthy()
	await hub.takeConnectionEvents()

	connection.connectionState = 'ready'
	connection.connectionError = null
	manager.connectBehavior = 'ready'
	const recovered = await hub.getSnapshot()
	expect(recovered.servers[0]?.state).toBe('ready')
	expect(recovered.servers[0]?.lastError ?? null).toBeNull()
	expect(recovered.servers[0]?.error ?? null).toBeNull()
	expect(recovered.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.reconnected',
			serverId: 'server-1',
			episodeId,
			state: 'ready',
		}),
	])
})

test('snapshot retries a previously ready server before emitting disconnect', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=ok.server-1',
	})
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'ready'
	manager.rows[0]!.name = 'home'

	const readySnapshot = await hub.getSnapshot()
	expect(readySnapshot.connectionEvents).toEqual([])
	expect(values.get('mcp-connection-episode/server-1')).toEqual({
		lastObservedState: 'ready',
		wasReady: true,
		episodeId: null,
		disconnectedEmitted: false,
	})

	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'ready'
	const recovered = await hub.getSnapshot()
	expect(manager.connectCount).toBe(1)
	expect(recovered.servers[0]?.state).toBe('ready')
	expect(recovered.connectionEvents).toEqual([])

	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'disconnected'
	const down = await hub.getSnapshot()
	expect(manager.connectCount).toBe(3)
	expect(down.servers[0]?.state).toBe('disconnected')
	expect(down.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'home',
			state: 'disconnected',
			previousState: 'ready',
		}),
	])
	const episode = values.get('mcp-connection-episode/server-1') as {
		episodeId: string
		disconnectedEmitted: boolean
	}
	expect(episode.disconnectedEmitted).toBe(true)
	expect(episode.episodeId).toBeTruthy()

	const stillDown = await hub.getSnapshot()
	expect(manager.connectCount).toBe(3)
	expect(stillDown.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			episodeId: (
				values.get('mcp-connection-episode/server-1') as { episodeId: string }
			).episodeId,
		}),
	])
	expect(await hub.takeConnectionEvents()).toHaveLength(1)
	expect(await hub.peekConnectionEvents()).toEqual([])

	connection.connectionState = 'ready'
	const back = await hub.getSnapshot()
	expect(back.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.reconnected',
			serverId: 'server-1',
			episodeId: episode.episodeId,
			state: 'ready',
		}),
	])

	const batchWrites = (
		state.storage.put as ReturnType<typeof vi.fn>
	).mock.calls.filter(
		(call): call is [Record<string, unknown>] =>
			typeof call[0] === 'object' &&
			call[0] !== null &&
			'mcp-connection-events-pending' in call[0],
	)
	expect(batchWrites.length).toBeGreaterThan(0)
	for (const [entries] of batchWrites) {
		expect(
			Object.keys(entries).some((key) =>
				key.startsWith('mcp-connection-episode/'),
			),
		).toBe(true)
	}
})

test('reconnect tries stored refresh before wiping tokens and stamps lastError when that parks authenticating', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl, connection } = await seedReadyHomeServer({
		hub,
		manager,
	})
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'expired-at',
		refresh_token: 'rotating-rt',
	}
	const tokenKey = '/Kody/server-1/client-1/token'
	values.set(tokenKey, {
		access_token: 'expired-at',
		refresh_token: 'rotating-rt',
	})
	manager.connectBehavior = 'ready'
	const refreshed = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl,
	})
	expect(refreshed.state).toBe('ready')
	expect(refreshed.lastError ?? null).toBeNull()
	expect(refreshed.hasRefreshToken).toBe(true)
	expect(values.get(tokenKey)).toEqual({
		access_token: 'expired-at',
		refresh_token: 'rotating-rt',
	})
	expect(manager.registerCount).toBe(0)

	manager.connectBehavior = 'oauth'
	connection.options.transport.authProvider.storedTokens = {
		refresh_token: 'rotating-rt',
	}
	const parked = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl,
	})
	expect(parked.state).toBe('authenticating')
	expect(parked.authUrl).toBeTruthy()
	expect(parked.error).toContain('could not be refreshed')
	expect(parked.lastError?.phase).toBe('token exchange')
	expect(parked.lastError?.message).not.toContain('Authorization completed')
	expect(parked.hasRefreshToken).toBe(false)
	expect(values.get(tokenKey)).toEqual({
		access_token: 'expired-at',
		refresh_token: 'rotating-rt',
	})
	expect(values.get('mcp-oauth-token-recovery/server-1')).toMatchObject({
		phase: 'token exchange',
	})
	expect(manager.registerCount).toBe(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth token recovery parked authenticating',
		expect.objectContaining({
			serverId: 'server-1',
			hadRefreshToken: true,
			stillHasRefreshToken: false,
		}),
	)
})

test('snapshot after a prior ready connection parks authenticating with a durable token-recovery lastError', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	connection.connectionState = 'authenticating'
	connection.connectionError = null
	connection.options.transport.authProvider.storedTokens = {
		access_token: 'stale-at',
	}
	manager.rows[0]!.auth_url =
		'https://auth.example/authorize?state=fresh.server-1'
	const snapshot = await hub.getSnapshot()
	const card = snapshot.servers[0]
	expect(card?.state).toBe('authenticating')
	expect(card?.error).toContain('has no refresh token to renew')
	expect(card?.lastError?.phase).toBe('token exchange')
	expect(card?.hasRefreshToken).toBe(false)
	expect(card?.error).not.toContain('Authorization completed')
	expect(snapshot.connectionEvents).toEqual([
		expect.objectContaining({
			topic: 'mcp.server.disconnected',
			serverId: 'server-1',
			serverName: 'home',
			state: 'authenticating',
			previousState: 'ready',
		}),
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth token recovery parked authenticating',
		expect.objectContaining({
			serverId: 'server-1',
			hadRefreshToken: false,
		}),
	)
})

test('authenticating park drops a leftover incomplete-discover lastError', async () => {
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=ok.server-1',
	})
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'discovering'
	connection.connectionError = "tool discovery didn't finish"
	const hung = await hub.getSnapshot()
	expect(hung.servers[0]?.lastError?.phase).toBe('tools/list')
	expect(hung.servers[0]?.error).toContain("tool discovery didn't finish")

	connection.connectionState = 'authenticating'
	const parked = await hub.getSnapshot()
	expect(parked.servers[0]?.state).toBe('authenticating')
	expect(parked.servers[0]?.lastError ?? null).toBeNull()
	expect(parked.servers[0]?.error ?? null).toBeNull()
	expect(connection.connectionError).toBeNull()
	expect(parked.servers[0]?.error ?? '').not.toContain(
		'Authorization completed',
	)
})

test('refreshServer keeps a token-recovery lastError when the server stays authenticating', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl, connection } = await seedReadyHomeServer({
		hub,
		manager,
	})
	connection.options.transport.authProvider.storedTokens = {
		refresh_token: 'rotating-rt',
	}
	manager.connectBehavior = 'oauth'
	const parked = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl,
	})
	expect(parked.lastError?.phase).toBe('token exchange')

	const refreshed = await hub.refreshServer({ serverId: 'server-1' })
	expect(refreshed.state).toBe('authenticating')
	expect(refreshed.lastError?.phase).toBe('token exchange')
	expect(refreshed.error).toContain('could not be refreshed')
	expect(refreshed.error).not.toContain('Authorization completed')
})

test('refreshServer returns the recovered ready connection after a lightweight retry', async () => {
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	values.set('mcp-oauth-token-recovery/server-1', {
		message: 'Stored OAuth tokens could not be refreshed',
		phase: 'token exchange',
		attemptId: 'stale-rt',
		at: '2026-09-14T00:00:00.000Z',
	})
	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'ready'
	const result = await hub.refreshServer({ serverId: 'server-1' })
	expect(result.state).toBe('ready')
	expect(result.lastError ?? null).toBeNull()
	expect(values.has('mcp-oauth-token-recovery/server-1')).toBe(false)
})

test('reconnectServer returns the recovered ready connection after a lightweight retry', async () => {
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl } = await seedReadyHomeServer({ hub, manager })
	manager.connectBehaviors = ['disconnected', 'ready']
	const result = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl,
	})
	expect(result.state).toBe('ready')
})

test('addServer returns the recovered ready connection after a lightweight retry', async () => {
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl } = await seedReadyHomeServer({ hub, manager })
	manager.connectBehaviors = ['disconnected', 'ready']
	const result = await hub.addServer({
		serverId: 'server-1',
		name: 'home',
		url: 'https://home.example.com/mcp',
		callbackUrl,
	})
	expect(result.state).toBe('ready')
})

test('handleOAuthCallback reports success after observe recovers a previously ready server', async () => {
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { callbackUrl, connection } = await seedReadyHomeServer({
		hub,
		manager,
	})
	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'ready'
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
	const result = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=ok.server-1`,
		callbackUrl,
	})
	expect(result.authSuccess).toBe(true)
	expect(result.authorizationNeeded).toBe(false)
	expect(result.lastError).toBeNull()
})

test('handleOAuthCallback reports a durable tool-discovery lastError when IdP succeeds but settle stays connected', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=ok.server-1',
	})
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
	manager.connectBehavior = 'connected'
	connection.connectionState = 'connected'
	connection.connectionError = null
	values.set('/Kody/server-1/oauth_discovery', {
		resource: 'https://mcp.posthog.com/',
		authorization_servers: ['https://auth.posthog.com/?client_secret=hidden'],
	})

	const result = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=ok.server-1`,
		callbackUrl,
	})

	expect(result.authSuccess).toBe(false)
	expect(result.authorizationNeeded).toBe(false)
	expect(result.lastError?.phase).toBe('tools/list')
	expect(result.lastError?.mcpEndpoint).toBe('https://mediarss.example/mcp')
	expect(result.lastError?.resource).toBe('https://mcp.posthog.com/')
	expect(result.lastError?.authServer).toBe('https://auth.posthog.com/')
	expect(result.authError).toContain("tool discovery didn't finish")
	expect(result.authError).toContain('phase tools/list')
	expect(result.authError).toContain(`id ${result.lastError?.attemptId}`)
	expect(result.authError?.match(/authorization completed/gi)?.length).toBe(1)
	expect(result.authError?.match(/\bphase\s/g)?.length).toBe(1)
	expect(result.authError?.match(/\bid\s/g)?.length).toBe(1)
	expect(result.authError).not.toContain('client_secret')
	expect(JSON.stringify(result.lastError)).not.toContain('hidden')
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp oauth callback settle incomplete',
		expect.objectContaining({
			attemptId: result.lastError?.attemptId,
			serverId: 'server-1',
			phase: 'tools/list',
			mcpEndpoint: 'https://mediarss.example/mcp',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/',
		}),
	)
	const logged = JSON.stringify(consoleWarn.mock.calls)
	expect(logged).not.toContain('hidden')
	expect(logged).not.toContain('client_secret')
})

test('replayed unusable callback after incomplete settle reports lastError instead of fake success', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=used.server-1',
	})
	manager.callbackMatches = false
	manager.connectBehavior = 'connected'
	if (!manager.mcpConnections['server-1']) {
		throw new Error('Fake connection was not seeded.')
	}
	manager.rows[0]!.auth_url = null
	const tokenKey = '/Kody/server-1/client-1/token'
	values.set(tokenKey, { access_token: 'still-valid' })
	values.set('/Kody/server-1/oauth_discovery', {
		resource: 'https://mcp.posthog.com/',
		authorization_servers: ['https://auth.posthog.com/'],
	})

	for (const inFlightState of ['connected', 'discovering', 'connecting']) {
		const connection = manager.mcpConnections['server-1']
		if (!connection) throw new Error('Fake connection was not seeded.')
		connection.connectionState = inFlightState
		connection.connectionError = null
		const outcome = await hub.handleOAuthCallback({
			url: `${callbackUrl}?code=abc&state=used.server-1`,
			callbackUrl,
		})
		expect(outcome.authSuccess).toBe(false)
		expect(outcome.authorizationNeeded).toBe(false)
		expect(outcome.lastError).toMatchObject({
			mcpEndpoint: 'https://mediarss.example/mcp',
			resource: 'https://mcp.posthog.com/',
			authServer: 'https://auth.posthog.com/',
		})
		expect(outcome.authError).toBeTruthy()
		if (inFlightState === 'connecting') {
			expect(outcome.lastError?.phase).toBe('mcp initialize')
			expect(outcome.authError).toContain('did not become ready')
		} else {
			expect(outcome.authError).toContain("tool discovery didn't finish")
		}
	}

	expect(manager.connectCount).toBe(1)
	expect(manager.rows[0]?.client_id).toBe('client-1')
	expect(values.get(tokenKey)).toEqual({ access_token: 'still-valid' })
})

test('add, reconnect, and refresh treat a discover timeout as a durable lastError', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
	manager.connectBehavior = 'connected'

	const added = await hub.addServer({
		serverId: 'server-1',
		name: 'mediarss',
		url: 'https://mediarss.example/mcp',
		callbackUrl,
	})
	expect(added.state).toBe('connected')
	expect(added.lastError?.phase).toBe('tools/list')
	expect(added.lastError?.mcpEndpoint).toBe('https://mediarss.example/mcp')
	expect(added.lastError?.attemptId).toBeTruthy()
	expect(added.error).toContain("tool discovery didn't finish")
	expect(added.error).toContain('phase tools/list')
	expect(added.error).toContain(`id ${added.lastError?.attemptId}`)
	expect(added.error?.match(/\bid\s/g)?.length).toBe(1)
	expect(manager.mcpConnections['server-1']?.connectionError).toBe(added.error)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp discover retrying legacy handshake',
		expect.objectContaining({
			serverId: 'server-1',
			mcpEndpoint: 'https://mediarss.example/mcp',
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp discover timeout incomplete',
		expect.objectContaining({
			attemptId: added.lastError?.attemptId,
			serverId: 'server-1',
			phase: 'tools/list',
		}),
	)

	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	const addedAttemptId = added.lastError?.attemptId
	connection.connectionState = 'discovering'
	const refreshed = await hub.refreshServer({ serverId: 'server-1' })
	expect(refreshed.state).toBe('discovering')
	expect(refreshed.lastError?.phase).toBe('tools/list')
	expect(refreshed.lastError?.attemptId).toBeTruthy()
	expect(refreshed.lastError?.attemptId).not.toBe(addedAttemptId)
	expect(refreshed.error).toContain("tool discovery didn't finish")
	expect(refreshed.error).toContain('phase tools/list')
	expect(refreshed.error).toContain(`id ${refreshed.lastError?.attemptId}`)
	expect(refreshed.error?.match(/\bid\s/g)?.length).toBe(1)

	connection.connectionState = 'disconnected'
	connection.connectionError = null
	manager.connectBehavior = 'connected'
	const reconnected = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl,
	})
	expect(reconnected.state).toBe('connected')
	expect(reconnected.lastError?.phase).toBe('tools/list')
	expect(reconnected.lastError?.mcpEndpoint).toBe(
		'https://mediarss.example/mcp',
	)
})

test('legacy retry that fails to connect keeps the catalog lastError', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	manager.connectBehaviors = ['connected', 'disconnected']
	manager.connectBehavior = 'disconnected'

	const added = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://analytics.example/mcp',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(added.state).toBe('disconnected')
	expect(added.lastError?.phase).toBe('tools/list')
	expect(added.error).toContain("tool discovery didn't finish")
	expect(added.error).toContain('phase tools/list')
	expect(manager.mcpConnections['server-1']?.connectionError).toBe(added.error)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp discover retrying legacy handshake',
		expect.objectContaining({
			serverId: 'server-1',
			attemptId: added.lastError?.attemptId,
		}),
	)
})

test('a later failed add does not keep a stale catalog lastError', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	manager.connectBehaviors = ['connected', 'disconnected']
	manager.connectBehavior = 'disconnected'

	const timedOut = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://analytics.example/mcp',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(timedOut.lastError?.phase).toBe('tools/list')

	manager.connectBehaviors = []
	manager.connectBehavior = 'disconnected'
	const failed = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://analytics.example/mcp',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(failed.state).toBe('disconnected')
	expect(failed.lastError).toBeNull()
	expect(failed.error).toBe('upstream closed')
})

test('healthy auto catalog stays on auto; modern-connect catalog timeout falls back to legacy and can reach ready', async () => {
	consoleWarn.mockImplementation(() => {})
	const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'

	const { state: healthyState, values: healthyValues } =
		createDurableObjectState()
	const healthyHub = new McpClientHub(healthyState, {} as Env)
	const healthy = mockModule.manager
	if (!healthy) throw new Error('Fake manager was not constructed.')
	healthy.connectBehavior = 'connected'
	healthy.discoverSucceedsOn = 'always'
	const healthyAdded = await healthyHub.addServer({
		serverId: 'server-healthy',
		name: 'feeds',
		url: 'https://feeds.example/mcp',
		callbackUrl,
	})
	expect(healthyAdded.state).toBe('ready')
	expect(healthyAdded.lastError ?? null).toBeNull()
	expect(healthy.registerCount).toBe(1)
	expect(healthy.discoverCount).toBe(1)
	expect(healthy.mcpConnections['server-healthy']?.options.client).toEqual({
		versionNegotiation: { mode: 'auto' },
	})
	expect(healthyValues.has('mcp-legacy-handshake/server-healthy')).toBe(false)

	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	manager.connectBehavior = 'connected'
	manager.discoverSucceedsOn = 'legacy'

	const added = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://user:secret@analytics.example/mcp?token=abc',
		callbackUrl,
	})
	expect(added.state).toBe('ready')
	expect(added.lastError ?? null).toBeNull()
	expect(manager.registerCount).toBe(2)
	expect(manager.discoverCount).toBe(2)
	expect(manager.mcpConnections['server-1']?.options.client).toEqual({
		versionNegotiation: { mode: 'legacy' },
	})
	expect(values.get('mcp-legacy-handshake/server-1')).toBe('catalog-timeout')
	const timeoutCall = consoleWarn.mock.calls.find(
		(call) => call[0] === 'mcp discover timeout incomplete',
	)
	const retryCall = consoleWarn.mock.calls.find(
		(call) => call[0] === 'mcp discover retrying legacy handshake',
	)
	const timeoutAttemptId = (
		timeoutCall?.[1] as { attemptId?: string } | undefined
	)?.attemptId
	expect(timeoutAttemptId).toBeTruthy()
	expect(retryCall?.[1]).toEqual(
		expect.objectContaining({
			serverId: 'server-1',
			attemptId: timeoutAttemptId,
			mcpEndpoint: 'https://analytics.example/mcp',
		}),
	)

	manager.discoverSucceedsOn = 'always'
	const reconnected = await hub.reconnectServer({
		serverId: 'server-1',
		callbackUrl,
	})
	expect(reconnected.state).toBe('ready')
	expect(manager.mcpConnections['server-1']?.options.client).toEqual({
		versionNegotiation: { mode: 'auto' },
	})
	expect(values.has('mcp-legacy-handshake/server-1')).toBe(false)

	manager.discoverSucceedsOn = 'legacy'
	seedServer({
		manager,
		callbackUrl,
		clientId: 'client-1',
		authUrl: 'https://auth.example/authorize?state=ok.server-1',
	})
	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.options.client = { versionNegotiation: { mode: 'auto' } }
	connection.connectionState = 'connected'
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
	manager.registerCount = 0
	manager.discoverCount = 0
	const oauth = await hub.handleOAuthCallback({
		url: `${callbackUrl}?code=abc&state=ok.server-1`,
		callbackUrl,
	})
	expect(oauth.authSuccess).toBe(true)
	expect(oauth.lastError).toBeNull()
	expect(manager.registerCount).toBe(1)
	expect(manager.mcpConnections['server-1']?.options.client).toEqual({
		versionNegotiation: { mode: 'legacy' },
	})
	expect(values.get('mcp-legacy-handshake/server-1')).toBe('catalog-timeout')
})

test('replacing a server forgets the catalog-timeout legacy mark and probes auto', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	manager.connectBehavior = 'connected'
	manager.discoverSucceedsOn = 'legacy'

	const added = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://analytics.example/mcp',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(added.state).toBe('ready')
	expect(values.get('mcp-legacy-handshake/server-1')).toBe('catalog-timeout')

	manager.discoverSucceedsOn = 'always'
	manager.registerCount = 0
	manager.discoverCount = 0
	const replaced = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://feeds.example/mcp',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(replaced.state).toBe('ready')
	expect(replaced.hasRefreshToken).toBe(false)
	expect(manager.registerCount).toBe(1)
	expect(manager.discoverCount).toBe(1)
	expect(manager.mcpConnections['server-1']?.options.client).toEqual({
		versionNegotiation: { mode: 'auto' },
	})
	expect(values.has('mcp-legacy-handshake/server-1')).toBe(false)
})

test('legacy fallback that parks on OAuth remembers the mark and keeps it after ready', async () => {
	consoleWarn.mockImplementation(() => {})
	const { state, values } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	manager.connectBehaviors = ['connected', 'oauth']
	manager.connectBehavior = 'oauth'
	manager.discoverSucceedsOn = 'never'

	const added = await hub.addServer({
		serverId: 'server-1',
		name: 'analytics',
		url: 'https://analytics.example/mcp',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(added.state).toBe('authenticating')
	expect(added.authUrl).toBeTruthy()
	expect(manager.mcpConnections['server-1']?.options.client).toEqual({
		versionNegotiation: { mode: 'legacy' },
	})
	expect(values.get('mcp-legacy-handshake/server-1')).toBe('catalog-timeout')

	const connection = manager.mcpConnections['server-1']
	if (!connection) throw new Error('Fake connection was not seeded.')
	connection.connectionState = 'connected'
	manager.discoverSucceedsOn = 'always'
	manager.callbackMatches = true
	manager.callbackResult = { serverId: 'server-1', authSuccess: true }
	const oauth = await hub.handleOAuthCallback({
		url: 'https://kody.codes/account/mcp-servers/oauth/callback?code=abc&state=ok.server-1',
		callbackUrl: 'https://kody.codes/account/mcp-servers/oauth/callback',
	})
	expect(oauth.authSuccess).toBe(true)
	expect(oauth.lastError).toBeNull()
	expect(manager.mcpConnections['server-1']?.options.client).toEqual({
		versionNegotiation: { mode: 'legacy' },
	})
	expect(values.get('mcp-legacy-handshake/server-1')).toBe('catalog-timeout')
})
