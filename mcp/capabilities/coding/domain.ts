import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { cursorCloudAgentDocsCapability } from './cursor-cloud-agent-docs.ts'
import { cursorCloudRestCapability } from './cursor-cloud-rest.ts'
import { githubRestApiDocsCapability } from './github-rest-api-docs.ts'
import { githubRestCapability } from './github-rest.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as GitHub repository actions, issues, pull requests, Cursor Cloud Agents API calls, public REST and Cloud Agents documentation fetch (markdown), and coding-agent workflows.',
	capabilities: [
		githubRestCapability,
		githubRestApiDocsCapability,
		cursorCloudRestCapability,
		cursorCloudAgentDocsCapability,
	],
})
