import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { valueDeleteCapability } from './value-delete.ts'
import { valueGetCapability } from './value-get.ts'
import { valueListCapability } from './value-list.ts'
import { valueSetCapability } from './value-set.ts'

export const valuesDomain = defineDomain({
	name: capabilityDomainNames.values,
	description:
		'Readable persisted values for user, app, or session scoped configuration that generated UIs may store and read back later.',
	keywords: ['value', 'config', 'storage', 'non-secret', 'generated ui'],
	capabilities: [
		valueSetCapability,
		valueGetCapability,
		valueListCapability,
		valueDeleteCapability,
	],
})
