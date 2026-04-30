import { expect, test, vi } from 'vitest'

const captureMessageMock = vi.fn()

vi.mock('@sentry/cloudflare', () => ({
	captureMessage: (...args: Array<unknown>) => captureMessageMock(...args),
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected readonly ctx: DurableObjectState
		protected readonly env: Env

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx
			this.env = env
		}
	},
}))

const { HomeConnectorSession } = await import('./session.ts')

type StoredHomeConnectorSessionState = {
	persisted: {
		connectorId: string | null
		connectorKind: string | null
		connectedAt: string | null
		lastSeenAt: string | null
	}
	tools: Array<{ name: string }>
}

async function waitForRestoreState(state: DurableObjectState) {
	const blockConcurrencyWhile = state.blockConcurrencyWhile as unknown as {
		mock: { results: Array<{ value: Promise<void> | undefined }> }
	}
	const blockPromise = blockConcurrencyWhile.mock.results[0]?.value
	if (!blockPromise) {
		throw new Error('Expected blockConcurrencyWhile to return restore promise.')
	}
	await blockPromise
}

function createState(
	input: {
		storedState?: StoredHomeConnectorSessionState | null
		webSockets?: Array<WebSocket>
	} = {},
) {
	const storedState = input.storedState ?? null
	const webSockets = input.webSockets ?? []
	const persistedEntries = new Map<string, unknown>()
	if (storedState) {
		persistedEntries.set('home-connector-session-state', storedState)
	}

	return {
		state: {
			storage: {
				get: vi.fn(async (key: string) => persistedEntries.get(key)),
				put: vi.fn(async (key: string, value: unknown) => {
					persistedEntries.set(key, value)
				}),
			},
			getWebSockets: vi.fn(() => webSockets),
			acceptWebSocket: vi.fn(),
			blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) =>
				callback(),
			),
		} as unknown as DurableObjectState,
		persistedEntries,
	}
}

test('constructor restores persisted state through blockConcurrencyWhile', async () => {
	captureMessageMock.mockReset()
	const { state } = createState({
		storedState: {
			persisted: {
				connectorId: 'default',
				connectorKind: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})

	const session = new HomeConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)
	await waitForRestoreState(state)

	expect(state.blockConcurrencyWhile).toHaveBeenCalledTimes(1)
	const response = await session.fetch(
		new Request('https://home-connectors/home/connectors/default/snapshot'),
	)
	expect(await response.json()).toMatchObject({
		connectorId: 'default',
		tools: [{ name: 'bond_shade_set_position' }],
	})
})

test('snapshot returns null when persisted connector has no live websocket', async () => {
	captureMessageMock.mockReset()
	const { state } = createState({
		storedState: {
			persisted: {
				connectorId: 'default',
				connectorKind: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
	})
	const session = new HomeConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)

	await waitForRestoreState(state)

	const response = await session.fetch(
		new Request('https://home-connectors/home/connectors/default/snapshot'),
	)
	expect(await response.json()).toBeNull()
})

test('websocket close clears connectedAt and tools from persisted state', async () => {
	captureMessageMock.mockReset()
	const { state, persistedEntries } = createState({
		storedState: {
			persisted: {
				connectorId: 'default',
				connectorKind: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})
	const session = new HomeConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)

	await waitForRestoreState(state)
	state.getWebSockets.mockReturnValue([])
	await session.webSocketClose({} as WebSocket, 1006, 'network', false)

	expect(captureMessageMock).toHaveBeenCalledWith(
		'Home connector session websocket closed code=1006 wasClean=false reason=network',
		expect.objectContaining({
			level: 'warning',
		}),
	)
	expect(persistedEntries.get('home-connector-session-state')).toMatchObject({
		persisted: {
			connectorId: 'default',
			connectedAt: null,
		},
		tools: [],
	})
})

test('stale websocket close preserves active connection state', async () => {
	captureMessageMock.mockReset()
	const activeSocket = {} as WebSocket
	const staleSocket = {} as WebSocket
	const { state, persistedEntries } = createState({
		storedState: {
			persisted: {
				connectorId: 'default',
				connectorKind: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [activeSocket, staleSocket],
	})
	const session = new HomeConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)

	await waitForRestoreState(state)
	state.getWebSockets.mockReturnValue([activeSocket])
	await session.webSocketClose(staleSocket, 1006, 'stale-socket', false)

	expect(persistedEntries.get('home-connector-session-state')).toMatchObject({
		persisted: {
			connectorId: 'default',
			connectedAt: '2026-04-26T05:00:00.000Z',
		},
		tools: [{ name: 'bond_shade_set_position' }],
	})
})

test('websocket heartbeat work is returned so the runtime can wait for persistence', async () => {
	captureMessageMock.mockReset()
	const { state, persistedEntries } = createState({
		storedState: {
			persisted: {
				connectorId: 'default',
				connectorKind: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})
	const session = new HomeConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)
	await waitForRestoreState(state)

	const handlerWork = session.webSocketMessage(
		{} as WebSocket,
		JSON.stringify({ type: 'connector.heartbeat' }),
	)
	expect(handlerWork).toBeInstanceOf(Promise)
	await handlerWork

	const persisted = persistedEntries.get(
		'home-connector-session-state',
	) as StoredHomeConnectorSessionState
	expect(persisted).toMatchObject({
		persisted: {
			connectorId: 'default',
			connectedAt: '2026-04-26T05:00:00.000Z',
		},
		tools: [{ name: 'bond_shade_set_position' }],
	})
	expect(
		(persisted as { persisted: { lastSeenAt: string } }).persisted.lastSeenAt,
	).not.toBe('2026-04-26T05:01:00.000Z')
})

test('websocket error clears connected state when the socket is gone', async () => {
	captureMessageMock.mockReset()
	const { state, persistedEntries } = createState({
		storedState: {
			persisted: {
				connectorId: 'default',
				connectorKind: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})
	const session = new HomeConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)

	await waitForRestoreState(state)
	state.getWebSockets.mockReturnValue([])
	await session.webSocketError({} as WebSocket, new Error('abnormal close'))

	expect(captureMessageMock).toHaveBeenCalledWith(
		'Home connector session websocket closed code=1011 wasClean=false reason=abnormal close',
		expect.objectContaining({
			level: 'warning',
		}),
	)
	expect(persistedEntries.get('home-connector-session-state')).toMatchObject({
		persisted: {
			connectorId: 'default',
			connectedAt: null,
		},
		tools: [],
	})
})
