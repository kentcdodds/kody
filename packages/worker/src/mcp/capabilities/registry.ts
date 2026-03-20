import { buildCapabilityRegistry } from './build-capability-registry.ts'
import { builtinDomains } from './builtin-domains.ts'

const registry = buildCapabilityRegistry(builtinDomains)

export const capabilityList = registry.capabilityList

export const capabilityDomains = registry.capabilityDomains

export const capabilityDomainDescriptionsByName =
	registry.capabilityDomainDescriptionsByName

export const capabilityMap = registry.capabilityMap

export const capabilitySpecs = registry.capabilitySpecs

export const capabilityToolDescriptors = registry.capabilityToolDescriptors

export const capabilityHandlers = registry.capabilityHandlers
