import { expect, test } from 'vitest'
import { createRemoteConnectorMcpClient } from '#worker/remote-connector/client.ts'
import {
	clearRemoteConnectorSnapshotCacheForTests,
	getCachedRemoteConnectorSnapshot,
} from '#worker/remote-connector/snapshot-cache.ts'

const runtimeTools = [
	{
		name: 'roku_press_key',
		title: 'Press Roku Key',
		description: 'Send a Roku ECP keypress.',
		inputSchema: {
			type: 'object',
			properties: {
				deviceId: { type: 'string' },
				key: { type: 'string' },
			},
			required: ['deviceId', 'key'],
		},
	},
] as const

function buildEnv(
	onGetSnapshot: () => Promise<unknown>,
	onRpcCallTool?: () => Promise<unknown>,
) {
	let snapshotCalls = 0
	const env = {
		REMOTE_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					async getSnapshot() {
						snapshotCalls += 1
						return onGetSnapshot()
					},
					async rpcCallTool() {
						if (!onRpcCallTool) throw new Error('rpcCallTool not stubbed')
						return onRpcCallTool()
					},
				}
			},
		},
	} as unknown as Env
	return {
		env,
		getSnapshotCalls: () => snapshotCalls,
	}
}

test('getCachedRemoteConnectorSnapshot reuses DO snapshots within TTL', async () => {
	clearRemoteConnectorSnapshotCacheForTests()
	const { env, getSnapshotCalls } = buildEnv(async () => ({
		connectorKind: 'roku',
		connectorId: 'home',
		connectedAt: '2026-03-25T00:00:00.000Z',
		lastSeenAt: '2026-03-25T00:00:01.000Z',
		tools: runtimeTools,
	}))
	const request = {
		env,
		userId: 'user-1',
		instanceId: 'home',
	}

	await getCachedRemoteConnectorSnapshot(request)
	await getCachedRemoteConnectorSnapshot(request)
	await createRemoteConnectorMcpClient(request).getSnapshot()

	expect(getSnapshotCalls()).toBe(1)
})

test('getCachedRemoteConnectorSnapshot does not retain disconnected snapshots', async () => {
	clearRemoteConnectorSnapshotCacheForTests()
	let connected = false
	const { env, getSnapshotCalls } = buildEnv(async () =>
		connected
			? {
					connectorKind: 'roku',
					connectorId: 'home',
					connectedAt: '2026-03-25T00:00:00.000Z',
					lastSeenAt: '2026-03-25T00:00:01.000Z',
					tools: runtimeTools,
				}
			: null,
	)
	const request = {
		env,
		userId: 'user-1',
		instanceId: 'home',
	}

	await expect(getCachedRemoteConnectorSnapshot(request)).resolves.toBeNull()
	connected = true
	await expect(
		getCachedRemoteConnectorSnapshot(request),
	).resolves.not.toBeNull()
	expect(getSnapshotCalls()).toBe(2)
})

test('a failed connector RPC evicts the cached snapshot', async () => {
	clearRemoteConnectorSnapshotCacheForTests()
	const { env, getSnapshotCalls } = buildEnv(
		async () => ({
			connectorKind: 'roku',
			connectorId: 'home',
			connectedAt: '2026-03-25T00:00:00.000Z',
			lastSeenAt: '2026-03-25T00:00:01.000Z',
			tools: runtimeTools,
		}),
		async () => {
			throw new Error('Remote connector websocket closed before RPC response.')
		},
	)
	const request = {
		env,
		userId: 'user-1',
		instanceId: 'home',
	}
	const client = createRemoteConnectorMcpClient(request)

	await client.getSnapshot()
	await client.getSnapshot()
	expect(getSnapshotCalls()).toBe(1)

	await expect(client.callTool('roku_press_key', {})).rejects.toThrow(
		'websocket closed',
	)

	// The disconnect signal must not keep serving the stale "connected" view.
	await client.getSnapshot()
	expect(getSnapshotCalls()).toBe(2)
})

test('getCachedRemoteConnectorSnapshot does not share entries across users', async () => {
	clearRemoteConnectorSnapshotCacheForTests()
	const { env, getSnapshotCalls } = buildEnv(async () => ({
		connectorKind: 'roku',
		connectorId: 'home',
		connectedAt: '2026-03-25T00:00:00.000Z',
		lastSeenAt: '2026-03-25T00:00:01.000Z',
		tools: runtimeTools,
	}))
	const connector = {
		env,
		instanceId: 'home',
	}

	await getCachedRemoteConnectorSnapshot({
		...connector,
		userId: 'user-1',
	})
	await getCachedRemoteConnectorSnapshot({
		...connector,
		userId: 'user-2',
	})

	expect(getSnapshotCalls()).toBe(2)
})
