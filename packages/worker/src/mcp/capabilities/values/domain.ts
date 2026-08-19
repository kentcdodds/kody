import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { valueDeleteCapability } from './value-delete.ts'
import { valueGetCapability } from './value-get.ts'
import { valueListCapability } from './value-list.ts'
import { valueSetCapability } from './value-set.ts'

export const valuesDomain = defineDomain({
	name: capabilityDomainNames.values,
	description:
		'Do not write new rows; load coding_guide_get({ guide: "values" }).',
	keywords: ['value', 'config', 'storage', 'non-secret'],
	capabilities: [
		valueSetCapability,
		valueGetCapability,
		valueListCapability,
		valueDeleteCapability,
	],
})
