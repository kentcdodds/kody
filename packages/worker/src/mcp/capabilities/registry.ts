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

function filterRegistryForPolicy(
	registry: BuiltCapabilityRegistry,
	callerContext: McpCallerContext,
): BuiltCapabilityRegistry {
	const deniedNames = callerContext.capabilityRestrictions?.denyNames ?? []
	const deniedDomains = callerContext.capabilityRestrictions?.denyDomains ?? []
	if (deniedNames.length === 0 && deniedDomains.length === 0) {
		return registry
	}
	const deniedNameSet = new Set(deniedNames)
	const deniedDomainSet = new Set(deniedDomains)
	const capabilityList = registry.capabilityList.filter(
		(capability) =>
			!deniedNameSet.has(capability.name) &&
			!deniedDomainSet.has(capability.domain),
	)
	const remainingDomains = registry.capabilityDomains.filter((domain) => {
		return capabilityList.some(
			(capability) => capability.domain === domain.name,
		)
	})
	const capabilityDomainDescriptionsByName = Object.fromEntries(
		Object.entries(registry.capabilityDomainDescriptionsByName).filter(
			([domainName]) =>
				remainingDomains.some((domain) => domain.name === domainName),
		),
	) as BuiltCapabilityRegistry['capabilityDomainDescriptionsByName']
	const capabilityMap = Object.fromEntries(
		capabilityList.map((capability) => [capability.name, capability]),
	)
	const capabilitySpecs = Object.fromEntries(
		Object.entries(registry.capabilitySpecs).filter(([name, spec]) => {
			return !deniedNameSet.has(name) && !deniedDomainSet.has(spec.domain)
		}),
	)
	const capabilityToolDescriptors = Object.fromEntries(
		Object.entries(registry.capabilityToolDescriptors).filter(([name]) => {
			const capability = registry.capabilityMap[name]
			return (
				capability != null &&
				!deniedNameSet.has(name) &&
				!deniedDomainSet.has(capability.domain)
			)
		}),
	)
	const capabilityHandlers = Object.fromEntries(
		Object.entries(registry.capabilityHandlers).filter(([name]) => {
			const capability = registry.capabilityMap[name]
			return (
				capability != null &&
				!deniedNameSet.has(name) &&
				!deniedDomainSet.has(capability.domain)
			)
		}),
	)
	return {
		capabilityList,
		capabilityDomains: remainingDomains,
		capabilityDomainDescriptionsByName,
		capabilityMap,
		capabilitySpecs,
		capabilityToolDescriptors,
		capabilityHandlers,
	}
}

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const synthesizedDomains: Array<SynthesizedRemoteConnectorDomain['domain']> =
		[]
	const settled = await Promise.allSettled(
		refs.map((ref) => synthesizeRemoteToolDomain(input.env, ref, refs)),
	)
	for (const [index, outcome] of settled.entries()) {
		if (outcome.status === 'fulfilled' && outcome.value) {
			synthesizedDomains.push(outcome.value.domain)
			continue
		}
		if (outcome.status === 'rejected') {
			const ref = refs[index]
			console.error(
				`[getCapabilityRegistryForContext] synthesizeRemoteToolDomain failed for ${ref?.kind ?? '?'}:${ref?.instanceId ?? '?'}`,
				outcome.reason,
			)
		}
	}
	if (synthesizedDomains.length === 0) {
		return filterRegistryForPolicy(staticRegistry, input.callerContext)
	}
	const registry = buildCapabilityRegistry([
		...builtinDomains,
		...synthesizedDomains,
	])
	return filterRegistryForPolicy(registry, input.callerContext)
}
