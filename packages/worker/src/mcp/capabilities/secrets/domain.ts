import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { secretDeleteCapability } from './secret-delete.ts'
import { secretListCapability } from './secret-list.ts'

export const secretsDomain = defineDomain({
	name: capabilityDomainNames.secrets,
	description:
		'Server-side secret references that can be discovered by name, listed with allowed-host metadata, and deleted without placing raw secret values into prompts or saved app source.',
	keywords: ['secret', 'credentials', 'reference', 'secure input'],
	capabilities: [
		secretListCapability,
		secretDeleteCapability,
	],
})
