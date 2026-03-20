import { type DomainSpec } from './types.ts'

export function defineDomain(spec: DomainSpec): DomainSpec {
	const seenNames = new Set<string>()
	for (const capability of spec.capabilities) {
		if (seenNames.has(capability.name)) {
			throw new Error(
				`Duplicate capability "${capability.name}" in domain "${spec.name}"`,
			)
		}
		seenNames.add(capability.name)
		if (capability.domain !== spec.name) {
			throw new Error(
				`Capability "${capability.name}" has domain "${capability.domain}" but is registered under domain "${spec.name}"`,
			)
		}
	}
	return spec
}
