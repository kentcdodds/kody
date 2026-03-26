import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { secretDeleteCapability } from './secret-delete.ts'
import { secretGetCapability } from './secret-get.ts'
import { secretListCapability } from './secret-list.ts'
import { secretUpdateCapability } from './secret-update.ts'

export const secretsDomain = defineDomain({
	name: capabilityDomainNames.secrets,
	description:
		'Server-side secret references that can be discovered by name, resolved during execute-time code, and explicitly updated or deleted without placing raw secret values into prompts or saved app source.',
	keywords: ['secret', 'credentials', 'reference', 'secure input'],
	capabilities: [
		secretListCapability,
		secretGetCapability,
		secretUpdateCapability,
		secretDeleteCapability,
	],
})
