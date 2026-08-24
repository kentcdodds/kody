import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { valueDeleteCapability } from './value-delete.ts'
import { valueGetCapability } from './value-get.ts'
import { valueListCapability } from './value-list.ts'

export const valuesDomain = defineDomain({
	name: capabilityDomainNames.values,
	description: 'Unadvertised leftover-row drain.',
	unadvertised: true,
	capabilities: [
		valueGetCapability,
		valueListCapability,
		valueDeleteCapability,
	],
})
