import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	clearCapabilityRegistryCacheForTests,
	getCapabilityRegistryForContext,
	getStaticRegistry,
} from '#mcp/capabilities/registry.ts'
import {
	clearRemoteConnectorSnapshotCacheForTests,
	remoteConnectorSnapshotTimeoutMs,
} from '#worker/remote-connector/snapshot-cache.ts'

test('getCapabilityRegistryForContext bypasses connector caches when no connectors are attached', async () => {
	clearCapabilityRegistryCacheForTests()
	const get = vi.fn()
	const prepare = vi.fn((query: string) => {
		const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
		return {
			bind() {
				return this
			},
			async all() {
				if (normalized.includes('feature_flag')) {
					throw new Error(
						'Feature-flag queries must not run when no capability declares featureFlag',
					)
				}
				return { results: [], meta: { changes: 0 } }
			},
			async first() {
				return null
			},
			async run() {
				return { meta: { changes: 0 } }
			},
		}
	})
	const env = {
		REMOTE_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get,
		},
		APP_DB: {
			prepare,
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
	expect(
		prepare.mock.calls.some(([query]) =>
			String(query).toLowerCase().includes('feature_flag'),
		),
	).toBe(false)
	expect(registry.capabilityMap).toBe(getStaticRegistry().capabilityMap)
})

test('getStaticRegistry memoizes the builtin registry', () => {
	const first = getStaticRegistry()
	const second = getStaticRegistry()
	expect(first).toBe(second)
	expect(first.capabilityMap.email_send).toBeTruthy()
	expect(Object.keys(first.capabilitySpecs).length).toBeGreaterThan(0)
	expect('email_send' in first.capabilityMap).toBe(true)
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

test('the email domain no longer exposes self-service inbox or sender-identity capabilities', () => {
	// Inboxes are auto-provisioned at {username}@<platform domain> and the
	// outbound from address is platform-assigned, so these capabilities were
	// removed and must never come back silently.
	const { capabilityMap } = getStaticRegistry()
	expect(capabilityMap.email_inbox_create).toBeUndefined()
	expect(capabilityMap.email_sender_identity_verify).toBeUndefined()
	expect(capabilityMap.email_inbox_list).toBeTruthy()
	expect(capabilityMap.email_send).toBeTruthy()
	expect(capabilityMap.email_reply).toBeTruthy()
	expect(capabilityMap.email_message_list).toBeTruthy()
	expect(capabilityMap.email_message_get).toBeTruthy()
	expect(capabilityMap.email_message_classify).toBeTruthy()
	expect(capabilityMap.email_sender_rule_list).toBeTruthy()
	expect(capabilityMap.email_sender_rule_set).toBeTruthy()
	expect(capabilityMap.email_sender_rule_delete).toBeTruthy()
	expect(capabilityMap.admin_system_email_sender_rule_list).toBeTruthy()
	expect(capabilityMap.admin_system_email_sender_rule_set).toBeTruthy()
	expect(capabilityMap.admin_system_email_sender_rule_delete).toBeTruthy()
})

test('getCapabilityRegistryForContext keeps healthy capabilities when a connector snapshot stalls', async () => {
	vi.useFakeTimers()
	clearCapabilityRegistryCacheForTests()
	clearRemoteConnectorSnapshotCacheForTests()
	const prepare = vi.fn(() => ({
		bind() {
			return this
		},
		async all() {
			return { results: [], meta: { changes: 0 } }
		},
		async first() {
			return null
		},
		async run() {
			return { meta: { changes: 0 } }
		},
	}))
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
							connectedAt: '2026-03-25T00:00:00.000Z',
							lastSeenAt: '2026-03-25T00:00:01.000Z',
							tools: [
								{
									name: 'roku_press_key',
									description: 'Send a Roku ECP keypress.',
									inputSchema: {
										type: 'object',
										properties: {
											key: { type: 'string' },
										},
										required: ['key'],
									},
								},
							],
						})
					},
				}
			},
		},
		APP_DB: {
			prepare,
		},
	} as unknown as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
		remoteConnectors: [{ instanceId: 'healthy' }, { instanceId: 'stalled' }],
	})

	try {
		const registryPromise = getCapabilityRegistryForContext({
			env,
			callerContext,
		})
		await vi.advanceTimersByTimeAsync(remoteConnectorSnapshotTimeoutMs)
		const registry = await registryPromise

		expect(registry.capabilityMap.email_send).toBeTruthy()
		expect(registry.capabilityMap['remote:healthy:roku_press_key']).toBeTruthy()
		expect(
			registry.capabilityMap['remote:stalled:roku_press_key'],
		).toBeUndefined()
	} finally {
		clearCapabilityRegistryCacheForTests()
		clearRemoteConnectorSnapshotCacheForTests()
		vi.useRealTimers()
	}
})
