import { expect, test } from 'vitest'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'

test('invocation token capabilities stay on the map as an unadvertised drain', async () => {
	const registry = await getStaticRegistry()
	expect(
		registry.capabilityDomains.some(
			(domain) => domain.name === 'invocationTokens',
		),
	).toBe(false)
	expect(registry.capabilitySpecs.packageInvocationTokenList).toBeUndefined()
	expect(registry.capabilitySpecs.packageInvocationTokenGet).toBeUndefined()
	expect(registry.capabilityMap.packageInvocationTokenList).toBeTruthy()
	expect(registry.capabilityMap.packageInvocationTokenGet).toBeTruthy()
	expect(registry.capabilitySpecs.packageGet).toBeTruthy()
})
