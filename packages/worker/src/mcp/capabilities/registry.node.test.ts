import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	getCapabilityRegistryForContext,
	getStaticRegistry,
} from '#mcp/capabilities/registry.ts'

test('getCapabilityRegistryForContext hides flag-gated capabilities when the flag is off', async () => {
	const userId = `user-registry-flag-gate-${crypto.randomUUID()}`
	const prepare = vi.fn(() => {
		return {
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
		}
	})
	const env = {
		APP_DB: {
			prepare,
		},
	} as unknown as Env
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored(userId),
			email: 'user-1@example.com',
			displayName: 'user-1',
			roles: ['admin'],
		},
	})

	const registry = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})
	const staticRegistry = await getStaticRegistry()

	expect(staticRegistry.capabilityMap).toHaveProperty('packageShareInvite')
	expect(registry.capabilityMap).not.toHaveProperty('packageShareInvite')
	expect(registry.capabilityMap).toHaveProperty('search')
})

test('getCapabilityRegistryForContext resolves flags while MCP server refs load', async () => {
	const userId = `user-registry-flag-overlap-${crypto.randomUUID()}`
	let releaseMcpRefs = () => {}
	const mcpRefs = new Promise<void>((resolve) => {
		releaseMcpRefs = resolve
	})
	let usersQueryStarted = false
	const prepare = vi.fn((sql: string) => {
		const isMcpRefs = sql.includes('mcp_server_settings')
		const isUser = sql.includes('FROM users')
		return {
			bind() {
				return this
			},
			async all() {
				if (isMcpRefs) await mcpRefs
				return { results: [], meta: { changes: 0 } }
			},
			async first() {
				if (isUser) usersQueryStarted = true
				return null
			},
			async run() {
				return { meta: { changes: 0 } }
			},
		}
	})
	const pending = getCapabilityRegistryForContext({
		env: { APP_DB: { prepare } } as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: 'user-1@example.com',
				displayName: 'user-1',
				roles: ['user'],
			},
		}),
	})
	await vi.waitFor(() => {
		expect(usersQueryStarted).toBe(true)
	})
	releaseMcpRefs()
	await pending
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
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'admin@example.com',
			displayName: 'admin',
			roles: ['admin'],
		},
	})
	const regularContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-1'),
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
	expect(adminRegistry.capabilityMap.adminUserMeterParity).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminRunLogSqlBilling).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminAccountDeletionAbort).toBeTruthy()
	expect(
		adminRegistry.capabilityMap.adminUnverifiedAccountPurgeRun,
	).toBeTruthy()
	expect(adminRegistry.capabilityMap.adminMailboxMaintenance).toBeTruthy()
	expect(
		adminRegistry.capabilityMap.adminCommunityOrphanForksCleanup,
	).toBeTruthy()
	expect(
		adminRegistry.capabilityMap.adminUserMeterStorageReconcile,
	).toBeTruthy()
	expect(
		adminRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(true)
	expect(regularRegistry.capabilityMap.adminUserList).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminUserMeterParity).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminRunLogSqlBilling).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminAccountDeletionAbort,
	).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminUnverifiedAccountPurgeRun,
	).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminUserMeterStorageReconcile,
	).toBeUndefined()
	expect(regularRegistry.capabilityMap.adminMailboxMaintenance).toBeUndefined()
	expect(
		regularRegistry.capabilityMap.adminCommunityOrphanForksCleanup,
	).toBeUndefined()
	expect(
		regularRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(false)
})

test('every capability declares a real org permission, and site-admin tools declare none', async () => {
	const registry = await getStaticRegistry()
	const invalid = registry.capabilityList
		.filter(
			(capability) =>
				capability.orgPermission !== 'none' &&
				!isOrgPermission(capability.orgPermission),
		)
		.map((capability) => capability.name)
	expect(invalid).toEqual([])
	const siteAdminWithOrgPermission = registry.capabilityList
		.filter(
			(capability) =>
				(capability.requiredRole || capability.requiredPermission) &&
				capability.orgPermission !== 'none',
		)
		.map((capability) => capability.name)
	expect(siteAdminWithOrgPermission).toEqual([])
	for (const spec of Object.values(registry.capabilitySpecs)) {
		expect(spec.orgPermission).toBe(
			registry.capabilityMap[spec.name]?.orgPermission,
		)
	}
})
