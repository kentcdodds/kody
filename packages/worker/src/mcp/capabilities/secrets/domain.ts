import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { jwtSignCapability } from './jwt-sign.ts'
import { secretDeleteCapability } from './secret-delete.ts'
import { secretListCapability } from './secret-list.ts'
import { secretSetCapability } from './secret-set.ts'

export const secretsDomain = defineDomain({
	name: capabilityDomainNames.secrets,
	description:
		'Server-side secret references that can be created, listed, and deleted without placing raw secret values into prompts, execute results, or package app source. Never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat.',
	keywords: ['secret', 'credentials', 'reference', 'secure input'],
	capabilities: [
		secretListCapability,
		secretSetCapability,
		secretDeleteCapability,
		jwtSignCapability,
	],
})
