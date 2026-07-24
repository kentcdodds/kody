import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { loadRemoteConnectorInstructionSummaries } from '#mcp/remote-connector-instruction-summaries.ts'
import {
	clearRemoteConnectorSnapshotCacheForTests,
	remoteConnectorSnapshotTimeoutMs,
} from '#worker/remote-connector/snapshot-cache.ts'

test('loadRemoteConnectorInstructionSummaries keeps healthy connectors when one snapshot stalls', async () => {
	vi.useFakeTimers()
	clearRemoteConnectorSnapshotCacheForTests()
	const env = {
		REMOTE_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get(name: string) {
				const [, instanceId] = JSON.parse(name) as [string, string]
				return {
					getSnapshot() {
						if (instanceId === 'stalled') {
							return new Promise(() => undefined)
						}
						return Promise.resolve({
							connectorId: instanceId,
							description: 'Healthy home automation connector.',
							connectedAt: '2026-03-25T00:00:00.000Z',
							lastSeenAt: '2026-03-25T00:00:01.000Z',
							tools: [],
						})
					},
				}
			},
		},
	} as unknown as Env
	const caller = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
		remoteConnectors: [{ instanceId: 'healthy' }, { instanceId: 'stalled' }],
	})

	try {
		const summariesPromise = loadRemoteConnectorInstructionSummaries({
			env,
			caller,
		})
		await vi.advanceTimersByTimeAsync(remoteConnectorSnapshotTimeoutMs)
		await expect(summariesPromise).resolves.toEqual([
			{
				name: 'healthy',
				domain: 'remote:healthy',
				description: 'Healthy home automation connector.',
			},
		])
	} finally {
		clearRemoteConnectorSnapshotCacheForTests()
		vi.useRealTimers()
	}
})
