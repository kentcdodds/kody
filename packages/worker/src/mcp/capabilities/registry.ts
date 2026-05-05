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
	const trustedRefs = refs.filter((ref) => ref.trusted)
	const synthesizedDomains: Array<SynthesizedRemoteConnectorDomain['domain']> =
		[]
	const settled = await Promise.allSettled(
		trustedRefs.map((ref) =>
			synthesizeRemoteToolDomain(input.env, ref, trustedRefs),
		),
	)
	for (const [index, outcome] of settled.entries()) {
		if (outcome.status === 'fulfilled' && outcome.value) {
			synthesizedDomains.push(outcome.value.domain)
			continue
		}
		if (outcome.status === 'rejected') {
			const ref = trustedRefs[index]
			console.error(
				`[getCapabilityRegistryForContext] synthesizeRemoteToolDomain failed for ${ref?.kind ?? '?'}:${ref?.instanceId ?? '?'}`,
				outcome.reason,
			)
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
