import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	clearCapabilityRegistryCacheForTests,
	capabilityMap,
	getCapabilityRegistryForContext,
} from '#mcp/capabilities/registry.ts'
import { clearRemoteConnectorSnapshotCacheForTests } from '#worker/remote-connector/snapshot-cache.ts'

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

function buildRemoteConnectorEnv(input?: {
	onGetSnapshot?: () => Promise<{
		connectorKind: string
		connectorId: string
		connectedAt: string
		lastSeenAt: string
		tools: ReadonlyArray<(typeof runtimeTools)[number]>
	}>
}) {
	const getSnapshot =
		input?.onGetSnapshot ??
		(() =>
			Promise.resolve({
				connectorKind: 'roku',
				connectorId: 'default',
				connectedAt: '2026-03-25T00:00:00.000Z',
				lastSeenAt: '2026-03-25T00:00:01.000Z',
				tools: runtimeTools,
			}))
	const get = vi.fn(() => ({
		getSnapshot,
	}))
	return {
		env: {
			REMOTE_CONNECTOR_SESSION: {
				idFromName(name: string) {
					return name
				},
				get,
			},
		} as unknown as Env,
		get,
		getSnapshot,
	}
}

beforeEach(() => {
	clearRemoteConnectorSnapshotCacheForTests()
	clearCapabilityRegistryCacheForTests()
})

test('getCapabilityRegistryForContext reuses cached snapshots within TTL', async () => {
	let snapshotCalls = 0
	const { env } = buildRemoteConnectorEnv({
		onGetSnapshot: async () => {
			snapshotCalls += 1
			return {
				connectorKind: 'roku',
				connectorId: 'default',
				connectedAt: '2026-03-25T00:00:00.000Z',
				lastSeenAt: '2026-03-25T00:00:01.000Z',
				tools: runtimeTools,
			}
		},
	})
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
		remoteConnectors: [{ kind: 'roku', instanceId: 'default' }],
	})

	await getCapabilityRegistryForContext({ env, callerContext })
	await getCapabilityRegistryForContext({ env, callerContext })

	expect(snapshotCalls).toBe(1)
})

test('getCapabilityRegistryForContext does not share snapshot cache across users', async () => {
	let snapshotCalls = 0
	const { env } = buildRemoteConnectorEnv({
		onGetSnapshot: async () => {
			snapshotCalls += 1
			return {
				connectorKind: 'roku',
				connectorId: 'default',
				connectedAt: '2026-03-25T00:00:00.000Z',
				lastSeenAt: '2026-03-25T00:00:01.000Z',
				tools: runtimeTools,
			}
		},
	})
	const connector = [{ kind: 'roku', instanceId: 'default' }] as const

	await getCapabilityRegistryForContext({
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user-1@example.com',
				displayName: 'user-1',
			},
			remoteConnectors: [...connector],
		}),
	})
	await getCapabilityRegistryForContext({
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-2',
				email: 'user-2@example.com',
				displayName: 'user-2',
			},
			remoteConnectors: [...connector],
		}),
	})

	expect(snapshotCalls).toBe(2)
})

test('getCapabilityRegistryForContext bypasses connector caches when no connectors are attached', async () => {
	const get = vi.fn()
	const env = {
		REMOTE_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get,
		},
	} as unknown as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
			roles: ['admin'],
		},
	})

	const registry = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})

	expect(get).not.toHaveBeenCalled()
	expect(registry.capabilityMap).toBe(capabilityMap)
})

test('getCapabilityRegistryForContext filters admin capabilities by current caller roles', async () => {
	const env = {} as Env
	const adminContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'admin@example.com',
			displayName: 'admin',
			roles: ['admin'],
		},
	})
	const regularContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'admin@example.com',
			displayName: 'admin',
			roles: ['user'],
		},
	})

	const adminRegistry = await getCapabilityRegistryForContext({
		env,
		callerContext: adminContext,
	})
	const regularRegistry = await getCapabilityRegistryForContext({
		env,
		callerContext: regularContext,
	})

	expect(adminRegistry.capabilityMap.admin_user_list).toBeTruthy()
	expect(
		adminRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(true)
	expect(regularRegistry.capabilityMap.admin_user_list).toBeUndefined()
	expect(
		regularRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(false)
})
