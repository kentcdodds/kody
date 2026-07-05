import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	clearCapabilityRegistryCacheForTests,
	capabilityMap,
	getCapabilityRegistryForContext,
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
		},
	})

	const registry = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})

	expect(get).not.toHaveBeenCalled()
	expect(registry.capabilityMap).toBe(capabilityMap)
})
