import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	clearCapabilityRegistryCacheForTests,
	getCapabilityRegistryForContext,
	getStaticRegistry,
} from '#mcp/capabilities/registry.ts'

test('getCapabilityRegistryForContext returns the static registry when no dynamic sources are attached', async () => {
	clearCapabilityRegistryCacheForTests()
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
	expect(Object.keys(first.capabilitySpecs).length).toBeGreaterThan(0)
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
	expect(adminRegistry.capabilityMap.admin_user_meter_parity).toBeTruthy()
	expect(adminRegistry.capabilityMap.admin_mailbox_maintenance).toBeTruthy()
	expect(
		adminRegistry.capabilityMap.admin_user_meter_storage_reconcile,
	).toBeTruthy()
	expect(
		adminRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(true)
	expect(regularRegistry.capabilityMap.admin_user_list).toBeUndefined()
	expect(regularRegistry.capabilityMap.admin_user_meter_parity).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.admin_user_meter_storage_reconcile,
	).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.admin_mailbox_maintenance,
	).toBeUndefined()
	expect(
		regularRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(false)
})
