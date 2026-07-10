import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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

const { RemoteConnectorSession } = await import('./session.ts')

type StoredRemoteConnectorSessionState = {
	persisted: {
		connectorId: string | null
		description?: string | null
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
		storedState?: StoredRemoteConnectorSessionState | null
		webSockets?: Array<WebSocket>
	} = {},
) {
	const storedState = input.storedState ?? null
	const webSockets = input.webSockets ?? []
	const persistedEntries = new Map<string, unknown>()
	if (storedState) {
		persistedEntries.set('remote-connector-session-state', storedState)
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

async function createRemoteConnectorSession(
	input: Parameters<typeof createState>[0] = {},
) {
	captureMessageMock.mockReset()
	const { state, persistedEntries } = createState(input)
	const session = new RemoteConnectorSession(
		{
			storage: state.storage,
			getWebSockets: state.getWebSockets,
			acceptWebSocket: state.acceptWebSocket,
			blockConcurrencyWhile: state.blockConcurrencyWhile,
		} as unknown as DurableObjectState,
		{} as Env,
	)
	await waitForRestoreState(state)
	return { session, state, persistedEntries }
}

test('remote connector session lifecycle across restore, snapshot, heartbeat, close, and error', async () => {
	// Websocket closes log an operational warning alongside the Sentry
	// capture asserted below.
	consoleWarn.mockImplementation(() => {})
	const restored = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				description: 'Local lighting automation.',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})

	expect(restored.state.blockConcurrencyWhile).toHaveBeenCalledTimes(1)
	const restoredSnapshot = await restored.session.getSnapshot()
	expect(restoredSnapshot).toMatchObject({
		connectorId: 'home',
		description: 'Local lighting automation.',
		tools: [{ name: 'bond_shade_set_position' }],
	})
	await expect(
		restored.session.rpcExportUserSession({
			userId: 'user-123',
			instanceId: 'home',
		}),
	).resolves.toEqual({
		persisted: {
			connectorId: 'home',
			description: 'Local lighting automation.',
			connectedAt: '2026-04-26T05:00:00.000Z',
			lastSeenAt: '2026-04-26T05:01:00.000Z',
		},
		tools: [{ name: 'bond_shade_set_position' }],
		connected: true,
	})

	const disconnected = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
	})
	expect(await disconnected.session.getSnapshot()).toBeNull()

	const closed = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})
	closed.state.getWebSockets.mockReturnValue([])
	await closed.session.webSocketClose({} as WebSocket, 1006, 'network', false)

	expect(captureMessageMock).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({
			level: 'warning',
		}),
	)
	expect(
		closed.persistedEntries.get('remote-connector-session-state'),
	).toMatchObject({
		persisted: {
			connectorId: 'home',
			connectedAt: null,
		},
		tools: [],
	})

	const activeSocket = {} as WebSocket
	const staleSocket = {} as WebSocket
	const staleClose = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [activeSocket, staleSocket],
	})
	staleClose.state.getWebSockets.mockReturnValue([activeSocket])
	await staleClose.session.webSocketClose(
		staleSocket,
		1006,
		'stale-socket',
		false,
	)
	expect(
		staleClose.persistedEntries.get('remote-connector-session-state'),
	).toMatchObject({
		persisted: {
			connectorId: 'home',
			connectedAt: '2026-04-26T05:00:00.000Z',
		},
		tools: [{ name: 'bond_shade_set_position' }],
	})

	const heartbeat = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})
	const handlerWork = heartbeat.session.webSocketMessage(
		{} as WebSocket,
		JSON.stringify({ type: 'connector.heartbeat' }),
	)
	expect(handlerWork).toBeInstanceOf(Promise)
	await handlerWork
	const heartbeatPersisted = heartbeat.persistedEntries.get(
		'remote-connector-session-state',
	) as StoredRemoteConnectorSessionState
	expect(heartbeatPersisted).toMatchObject({
		persisted: {
			connectorId: 'home',
			connectedAt: '2026-04-26T05:00:00.000Z',
		},
		tools: [{ name: 'bond_shade_set_position' }],
	})
	expect(heartbeatPersisted.persisted.lastSeenAt).not.toBe(
		'2026-04-26T05:01:00.000Z',
	)

	const errored = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [{} as WebSocket],
	})
	errored.state.getWebSockets.mockReturnValue([])
	await errored.session.webSocketError(
		{} as WebSocket,
		new Error('abnormal close'),
	)
	expect(captureMessageMock).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({
			level: 'warning',
		}),
	)
	expect(
		errored.persistedEntries.get('remote-connector-session-state'),
	).toMatchObject({
		persisted: {
			connectorId: 'home',
			connectedAt: null,
		},
		tools: [],
	})

	const socket = {} as WebSocket
	const dedupe = await createRemoteConnectorSession({
		storedState: {
			persisted: {
				connectorId: 'home',
				connectedAt: '2026-04-26T05:00:00.000Z',
				lastSeenAt: '2026-04-26T05:01:00.000Z',
			},
			tools: [{ name: 'bond_shade_set_position' }],
		},
		webSockets: [socket],
	})
	dedupe.state.getWebSockets.mockReturnValue([])
	await dedupe.session.webSocketError(socket, new Error('abnormal close'))
	await dedupe.session.webSocketClose(socket, 1006, 'runtime close', false)
	expect(captureMessageMock).toHaveBeenCalledTimes(1)
	expect(dedupe.state.storage.put).toHaveBeenCalledTimes(1)
	expect(
		dedupe.persistedEntries.get('remote-connector-session-state'),
	).toMatchObject({
		persisted: {
			connectorId: 'home',
			connectedAt: null,
		},
		tools: [],
	})
})
