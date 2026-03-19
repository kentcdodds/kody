import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { githubRestCapability } from './github-rest.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as GitHub repository actions, issues, pull requests, and coding-agent workflows.',
	capabilities: [githubRestCapability],
})
