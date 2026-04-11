import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import { builtinDomains } from './builtin-domains.ts'
import {
	type SynthesizedRemoteConnectorDomain,
	synthesizeRemoteToolDomain,
} from './home/index.ts'
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
	const synthesizedDomains: Array<SynthesizedRemoteConnectorDomain['domain']> =
		[]
	for (const ref of refs) {
		const synthesized = await synthesizeRemoteToolDomain(input.env, ref, refs)
		if (synthesized) {
			synthesizedDomains.push(synthesized.domain)
		}
	}
	if (synthesizedDomains.length === 0) {
		return staticRegistry
	}
	const registry = buildCapabilityRegistry([
		...builtinDomains,
		...synthesizedDomains,
	])
	return registry
}
