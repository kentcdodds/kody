import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import { builtinDomains } from './builtin-domains.ts'
import { synthesizeRemoteToolDomain } from './remote-connector/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'

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
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return staticRegistry
	}
	const synthesized = await Promise.all(
		refs.map((ref) =>
			synthesizeRemoteToolDomain({ env: input.env, userId, ref }),
		),
	)
	const synthesizedDomains = synthesized.flatMap((domain) =>
		domain ? [domain.domain] : [],
	)
	if (synthesizedDomains.length === 0) {
		return staticRegistry
	}
	const registry = buildCapabilityRegistry([
		...builtinDomains,
		...synthesizedDomains,
	])
	return registry
}
