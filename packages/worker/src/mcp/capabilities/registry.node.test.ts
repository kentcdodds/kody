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
	expect(registry.capabilityMap).toBe((await getStaticRegistry()).capabilityMap)
})

test('getStaticRegistry memoizes the builtin registry', async () => {
	const first = await getStaticRegistry()
	const second = await getStaticRegistry()
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

	expect(adminRegistry.capabilityMap.adminUserList).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminUserStableIdConflict).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminUserMeterParity).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminAccountDeletionAbort).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminMailboxMaintenance).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminSignupModeGet).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminSignupModeSet).toBeTruthy()
	expect(
		adminRegistry.capabilityMap.adminUserMeterStorageReconcile,
	).toBeTruthy()
	expect(
		adminRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(true)
	expect(regularRegistry.capabilityMap.adminUserList).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminUserStableIdConflict,
	).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminUserMeterParity).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminAccountDeletionAbort,
	).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminUserMeterStorageReconcile,
	).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminMailboxMaintenance).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminSignupModeGet).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminSignupModeSet).toBeUndefined()
	expect(
		regularRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(false)
})
