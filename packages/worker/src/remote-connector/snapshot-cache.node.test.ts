import { beforeEach, expect, test } from 'vitest'
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

function buildEnv(onGetSnapshot: () => Promise<unknown>) {
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
				}
			},
		},
	} as unknown as Env
	return {
		env,
		getSnapshotCalls: () => snapshotCalls,
	}
}

beforeEach(() => {
	clearRemoteConnectorSnapshotCacheForTests()
})

test('getCachedRemoteConnectorSnapshot reuses DO snapshots within TTL', async () => {
	const { env, getSnapshotCalls } = buildEnv(async () => ({
		connectorKind: 'roku',
		connectorId: 'default',
		connectedAt: '2026-03-25T00:00:00.000Z',
		lastSeenAt: '2026-03-25T00:00:01.000Z',
		tools: runtimeTools,
	}))
	const request = {
		env,
		userId: 'user-1',
		kind: 'roku',
		instanceId: 'default',
	}

	await getCachedRemoteConnectorSnapshot(request)
	await getCachedRemoteConnectorSnapshot(request)
	await createRemoteConnectorMcpClient(request).getSnapshot()

	expect(getSnapshotCalls()).toBe(1)
})

test('getCachedRemoteConnectorSnapshot does not share entries across users', async () => {
	const { env, getSnapshotCalls } = buildEnv(async () => ({
		connectorKind: 'roku',
		connectorId: 'default',
		connectedAt: '2026-03-25T00:00:00.000Z',
		lastSeenAt: '2026-03-25T00:00:01.000Z',
		tools: runtimeTools,
	}))
	const connector = {
		env,
		kind: 'roku',
		instanceId: 'default',
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
