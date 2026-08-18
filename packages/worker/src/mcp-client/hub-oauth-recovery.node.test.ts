import { expect, test, vi } from 'vitest'
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
			authProvider: {
				serverId: string
				clientId?: string
				authUrl?: string
				redirectUrl: string
			}
		}
	}
}

type FakeManager = {
	rows: Array<FakeServerRow>
	mcpConnections: Record<string, FakeConnection>
	connectCount: number
	connectBehavior: 'oauth' | 'ready' | 'disconnected'
	connectBehaviors: Array<'oauth' | 'ready' | 'disconnected'>
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

vi.mock('agents/mcp/client', () => ({
	MCPClientManager: class {
		rows: Array<FakeServerRow> = []
		mcpConnections: Record<string, FakeConnection> = {}
		connectCount = 0
		connectBehavior: 'oauth' | 'ready' | 'disconnected' = 'oauth'
		connectBehaviors: Array<'oauth' | 'ready' | 'disconnected'> = []
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

		async restoreConnectionsFromStorage() {}

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
			if (connectBehavior === 'disconnected') {
				connection.connectionState = 'disconnected'
				connection.connectionError = 'upstream closed'
				return { state: 'disconnected' }
			}
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

		async discoverIfConnected() {}

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

	for (const pastOAuthState of ['connecting', 'ready']) {
		connection.connectionState = pastOAuthState
		const outcome = await hub.handleOAuthCallback({
			url: `${callbackUrl}?code=abc&state=used.server-1`,
			callbackUrl,
		})
		expect(outcome).toEqual({
			serverId: 'server-1',
			authSuccess: true,
			authError: null,
			serverName: 'mediarss',
			authorizationNeeded: false,
		})
	}
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
	expect(stillDown.connectionEvents).toEqual([])

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

test('refreshServer returns the recovered ready connection after a lightweight retry', async () => {
	const { state } = createDurableObjectState()
	const hub = new McpClientHub(state, {} as Env)
	const manager = mockModule.manager
	if (!manager) throw new Error('Fake manager was not constructed.')
	const { connection } = await seedReadyHomeServer({ hub, manager })
	connection.connectionState = 'disconnected'
	manager.connectBehavior = 'ready'
	const result = await hub.refreshServer({ serverId: 'server-1' })
	expect(result.state).toBe('ready')
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
		url: 'https://kody-home.doddsfamily.us/mcp',
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
})
