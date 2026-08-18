import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	mcpServerDisconnectedTopic,
	mcpServerReconnectedTopic,
	type McpServerConnectionEvent,
} from './connection-episodes.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listEnabledMcpServerSettingRows: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

vi.mock('./settings-repo.ts', () => ({
	listEnabledMcpServerSettingRows: mocks.listEnabledMcpServerSettingRows,
}))

const {
	dispatchMcpServerConnectionSubscriptionEvents,
	emitMcpServerConnectionEventsIfNeeded,
} = await import('./package-subscriptions.ts')

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env
}

function disconnectedEvent(): McpServerConnectionEvent {
	return {
		topic: mcpServerDisconnectedTopic,
		eventId: 'event-1',
		episodeId: 'episode-1',
		serverId: 'server-home',
		serverName: 'home',
		state: 'disconnected',
		previousState: 'ready',
		observedAt: '2026-08-18T17:54:07.000Z',
	}
}

function subscribedManifest(input: { topic: string }) {
	return {
		manifest: {
			name: '@user/home-watch',
			kody: {
				id: 'home-watch',
				description: 'Home MCP notifier',
				subscriptions: {
					[input.topic]: {
						handler: './src/on-mcp-server.ts',
					},
				},
			},
		},
	}
}

test('mcp.server.disconnected fans out a lean same-user payload', async () => {
	const savedPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'home-watch',
		name: '@user/home-watch',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce(
		subscribedManifest({ topic: mcpServerDisconnectedTopic }),
	)
	const env = createEnv()
	const event = disconnectedEvent()

	const results = await dispatchMcpServerConnectionSubscriptionEvents({
		env,
		userId: 'user-1',
		event,
	})

	expect(results).toHaveLength(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: mcpServerDisconnectedTopic,
			idempotencyKey: `mcp-server:${mcpServerDisconnectedTopic}:episode-1:package-1`,
			source: 'mcp-client',
			params: {
				event: mcpServerDisconnectedTopic,
				event_id: 'event-1',
				server: {
					id: 'server-home',
					name: 'home',
					state: 'disconnected',
					previous_state: 'ready',
					episode_id: 'episode-1',
				},
				observed_at: '2026-08-18T17:54:07.000Z',
				account_url: 'https://example.com/account/mcp-servers/server-home',
			},
		}),
	)
	const params = mocks.invokePackageSubscription.mock.calls[0]?.[0]?.params as
		| Record<string, unknown>
		| undefined
	expect(params).not.toHaveProperty('url')
	expect(params).not.toHaveProperty('authUrl')
	expect(params).not.toHaveProperty('access_token')
	expect(JSON.stringify(params)).not.toContain('Bearer')
})

test('mcp.server connection events skip disabled servers and never throw', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.invokePackageSubscription.mockReset()
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageManifestBySourceId.mockReset()
	mocks.listEnabledMcpServerSettingRows.mockReset()
	const env = createEnv()
	const event = disconnectedEvent()

	mocks.listEnabledMcpServerSettingRows.mockResolvedValueOnce([])
	await emitMcpServerConnectionEventsIfNeeded({
		env,
		userId: 'user-1',
		events: [event],
	})
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()

	mocks.listEnabledMcpServerSettingRows.mockResolvedValueOnce([
		{ id: 'server-home' },
	])
	mocks.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	await expect(
		emitMcpServerConnectionEventsIfNeeded({
			env,
			userId: 'user-1',
			events: [event],
		}),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp.server connection package subscription discovery incomplete',
		expect.objectContaining({
			eventId: 'event-1',
			topic: mcpServerDisconnectedTopic,
			serverName: 'home',
		}),
	)

	mocks.listEnabledMcpServerSettingRows.mockResolvedValueOnce([
		{ id: 'server-home' },
	])
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'package-1',
			userId: 'user-1',
			sourceId: 'source-1',
			kodyId: 'home-watch',
			name: '@user/home-watch',
		},
	])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce(
		subscribedManifest({ topic: mcpServerReconnectedTopic }),
	)
	await emitMcpServerConnectionEventsIfNeeded({
		env,
		userId: 'user-1',
		events: [
			{
				...event,
				topic: mcpServerReconnectedTopic,
				state: 'ready',
				previousState: 'disconnected',
			},
		],
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			topic: mcpServerReconnectedTopic,
		}),
	)
})
