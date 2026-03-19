import { defineCapability } from './define-capability.ts'
import { type CapabilityDomain } from './domain-metadata.ts'
import {
	type Capability,
	type CapabilityDefinition,
	type CapabilitySchemaDefinition,
} from './types.ts'

export function defineDomainCapability<
	TInputSchema extends CapabilitySchemaDefinition,
	TOutputSchema extends CapabilitySchemaDefinition | undefined = undefined,
>(
	domain: CapabilityDomain,
	definition: Omit<
		CapabilityDefinition<TInputSchema, TOutputSchema>,
		'domain'
	>,
): Capability {
	return defineCapability({
		...definition,
		domain,
	})
}
