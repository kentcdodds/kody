import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import { builtinDomains } from './builtin-domains.ts'
import { synthesizeHomeDomain } from './home/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

const staticRegistry = buildCapabilityRegistry(builtinDomains)

export const capabilityList = staticRegistry.capabilityList

export const capabilityDomains = staticRegistry.capabilityDomains

export const capabilityDomainDescriptionsByName =
	staticRegistry.capabilityDomainDescriptionsByName

export const capabilityMap = staticRegistry.capabilityMap

export const capabilitySpecs = staticRegistry.capabilitySpecs

export const capabilityToolDescriptors =
	staticRegistry.capabilityToolDescriptors

export const capabilityHandlers = staticRegistry.capabilityHandlers

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
	const homeDomain = await synthesizeHomeDomain(input.env, {
		connectorId: input.callerContext.homeConnectorId ?? null,
		baseUrl: input.callerContext.baseUrl,
	})
	if (!homeDomain) {
		return staticRegistry
	}
	const registry = buildCapabilityRegistry([
		...builtinDomains,
		homeDomain.domain,
	])
	return registry
}
