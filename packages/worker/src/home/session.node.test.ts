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

function createState(input: {
	storedState?: {
		persisted: {
			connectorId: string | null
			connectorKind: string | null
			connectedAt: string | null
			lastSeenAt: string | null
		}
		tools: Array<{ name: string }>
	} | null
	webSockets?: Array<WebSocket>
} = {}) {
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
		} as unknown as DurableObjectState,
		persistedEntries,
	}
}

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
		} as unknown as DurableObjectState,
		{} as Env,
	)

	await new Promise((resolve) => setTimeout(resolve, 0))

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
		} as unknown as DurableObjectState,
		{} as Env,
	)

	await new Promise((resolve) => setTimeout(resolve, 0))
	session.webSocketClose({} as WebSocket, 1006, 'network', false)
	await new Promise((resolve) => setTimeout(resolve, 0))

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
