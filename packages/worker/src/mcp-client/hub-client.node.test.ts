import { expect, test, vi } from 'vitest'
import { mcpServerDisconnectedTopic } from './connection-episodes.ts'
import {
	clearMcpClientHubSnapshotCacheForTests,
	getCachedMcpClientHubServers,
	getCachedMcpClientHubSnapshot,
} from './hub-client.ts'

const mocks = vi.hoisted(() => ({
	emitMcpServerConnectionEventsIfNeeded: vi.fn(async () => true),
	peekServers: vi.fn(async () => ({ servers: [] })),
	peekConnectionEvents: vi.fn(async () => []),
	ackConnectionEvents: vi.fn(async () => undefined),
	getSnapshot: vi.fn(async () => ({ servers: [], connectionEvents: [] })),
}))

vi.mock('./package-subscriptions.ts', () => ({
	emitMcpServerConnectionEventsIfNeeded: (...args: Array<unknown>) =>
		mocks.emitMcpServerConnectionEventsIfNeeded(...args),
}))

function disconnectedEvent() {
	return {
		topic: mcpServerDisconnectedTopic,
		eventId: 'event-1',
		episodeId: 'episode-1',
		serverId: 'server-home',
		serverName: 'home',
		state: 'authenticating' as const,
		previousState: 'ready' as const,
		observedAt: '2026-09-15T01:46:00.000Z',
	}
}

function createEnv() {
	const stub = {
		peekServers: mocks.peekServers,
		peekConnectionEvents: mocks.peekConnectionEvents,
		ackConnectionEvents: mocks.ackConnectionEvents,
		getSnapshot: mocks.getSnapshot,
	}
	return {
		MCP_CLIENT_HUB: {
			idFromName: (name: string) => name,
			get: () => stub,
		},
	} as unknown as Env
}

test('waiting peek dispatches a queued mcp.server.disconnected before ack', async () => {
	clearMcpClientHubSnapshotCacheForTests()
	mocks.emitMcpServerConnectionEventsIfNeeded.mockClear()
	mocks.peekServers.mockClear()
	mocks.peekConnectionEvents.mockClear()
	mocks.ackConnectionEvents.mockClear()
	mocks.getSnapshot.mockClear()

	const event = disconnectedEvent()
	mocks.peekServers.mockResolvedValueOnce({
		servers: [
			{
				serverId: 'server-home',
				name: 'home',
				state: 'authenticating',
			},
		],
	})
	mocks.peekConnectionEvents.mockResolvedValueOnce([event])
	const waitUntil = vi.fn()
	const env = createEnv()

	const peeked = await getCachedMcpClientHubServers({
		env,
		userId: 'user-1',
		waitUntil,
	})
	expect(peeked.servers[0]).toMatchObject({
		serverId: 'server-home',
		state: 'authenticating',
	})
	expect(waitUntil).toHaveBeenCalledTimes(1)
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).not.toHaveBeenCalled()
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()

	await waitUntil.mock.calls[0]?.[0]
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		events: [event],
	})
	expect(mocks.ackConnectionEvents).toHaveBeenCalledTimes(1)
	expect(mocks.ackConnectionEvents).toHaveBeenCalledWith(['event-1'])

	mocks.peekServers.mockClear()
	mocks.peekConnectionEvents.mockClear()
	const cached = await getCachedMcpClientHubServers({
		env,
		userId: 'user-1',
		waitUntil,
	})
	expect(cached.servers[0]?.serverId).toBe('server-home')
	expect(mocks.peekServers).not.toHaveBeenCalled()
	expect(mocks.peekConnectionEvents).not.toHaveBeenCalled()

	clearMcpClientHubSnapshotCacheForTests()
	mocks.emitMcpServerConnectionEventsIfNeeded.mockClear()
	mocks.ackConnectionEvents.mockClear()
	mocks.getSnapshot.mockResolvedValueOnce({
		servers: [{ serverId: 'server-home', name: 'home', state: 'ready' }],
		connectionEvents: [],
	})
	const snapshot = await getCachedMcpClientHubSnapshot({
		env,
		userId: 'user-1',
	})
	expect(snapshot.servers[0]?.state).toBe('ready')
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).not.toHaveBeenCalled()
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()

	clearMcpClientHubSnapshotCacheForTests()
	mocks.emitMcpServerConnectionEventsIfNeeded.mockClear()
	mocks.ackConnectionEvents.mockClear()
	mocks.peekServers.mockResolvedValueOnce({
		servers: [
			{
				serverId: 'server-home',
				name: 'home',
				state: 'authenticating',
			},
		],
	})
	mocks.peekConnectionEvents.mockResolvedValueOnce([event])
	await getCachedMcpClientHubServers({
		env,
		userId: 'user-2',
	})
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).toHaveBeenCalledWith({
		env,
		userId: 'user-2',
		events: [event],
	})
	expect(mocks.ackConnectionEvents).toHaveBeenCalledTimes(1)
	expect(mocks.ackConnectionEvents).toHaveBeenCalledWith(['event-1'])
})

test('waiting peek does not ack when dispatch reports incomplete', async () => {
	clearMcpClientHubSnapshotCacheForTests()
	mocks.emitMcpServerConnectionEventsIfNeeded.mockReset()
	mocks.emitMcpServerConnectionEventsIfNeeded.mockResolvedValueOnce(false)
	mocks.peekServers.mockReset()
	mocks.peekConnectionEvents.mockReset()
	mocks.ackConnectionEvents.mockReset()

	const event = disconnectedEvent()
	mocks.peekServers.mockResolvedValueOnce({
		servers: [
			{
				serverId: 'server-home',
				name: 'home',
				state: 'authenticating',
			},
		],
	})
	mocks.peekConnectionEvents.mockResolvedValueOnce([event])
	await getCachedMcpClientHubServers({
		env: createEnv(),
		userId: 'user-incomplete',
	})
	expect(mocks.emitMcpServerConnectionEventsIfNeeded).toHaveBeenCalledTimes(1)
	expect(mocks.ackConnectionEvents).not.toHaveBeenCalled()
})
