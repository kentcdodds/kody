import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	clearCapabilityRegistryCacheForTests,
	capabilityMap,
	capabilitySpecs,
	getCapabilityRegistryForContext,
	getStaticRegistry,
} from '#mcp/capabilities/registry.ts'

test('getCapabilityRegistryForContext bypasses connector caches when no connectors are attached', async () => {
	clearCapabilityRegistryCacheForTests()
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
	expect(registry.capabilityMap).toBe(getStaticRegistry().capabilityMap)
})

test('getStaticRegistry memoizes and the lazy constant exports mirror it', () => {
	expect(getStaticRegistry()).toBe(getStaticRegistry())
	expect(capabilityMap.email_send).toBe(
		getStaticRegistry().capabilityMap.email_send,
	)
	expect(Object.keys(capabilitySpecs)).toEqual(
		Object.keys(getStaticRegistry().capabilitySpecs),
	)
	expect('email_send' in capabilityMap).toBe(true)
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
	expect(capabilityMap.email_inbox_create).toBeUndefined()
	expect(capabilityMap.email_sender_identity_verify).toBeUndefined()
	expect(capabilityMap.email_inbox_list).toBeTruthy()
	expect(capabilityMap.email_send).toBeTruthy()
	expect(capabilityMap.email_reply).toBeTruthy()
	expect(capabilityMap.email_message_list).toBeTruthy()
	expect(capabilityMap.email_message_get).toBeTruthy()
})
