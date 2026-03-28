import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { cloudflareApiDocsCapability } from './cloudflare-api-docs.ts'
import { cloudflareRestCapability } from './cloudflare-rest.ts'
import { cursorCloudAgentDocsCapability } from './cursor-cloud-agent-docs.ts'
import { cursorCloudRestCapability } from './cursor-cloud-rest.ts'
import { generatedUiOAuthGuideCapability } from './generated-ui-oauth-guide.ts'
import { generatedUiSecretGuideCapability } from './generated-ui-secret-guide.ts'
import { githubGraphqlApiDocsCapability } from './github-graphql-api-docs.ts'
import { githubGraphqlCapability } from './github-graphql.ts'
import { githubRestApiDocsCapability } from './github-rest-api-docs.ts'
import { githubRestCapability } from './github-rest.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as GitHub repository actions, issues, pull requests, GitHub GraphQL queries, Cursor Cloud Agents API calls, Cloudflare API calls, public REST/GraphQL/Cloud Agents/Cloudflare documentation fetch (markdown), and coding-agent workflows.',
	capabilities: [
		githubRestCapability,
		githubRestApiDocsCapability,
		githubGraphqlCapability,
		githubGraphqlApiDocsCapability,
		generatedUiOAuthGuideCapability,
		generatedUiSecretGuideCapability,
		cursorCloudRestCapability,
		cursorCloudAgentDocsCapability,
		cloudflareRestCapability,
		cloudflareApiDocsCapability,
	],
})
