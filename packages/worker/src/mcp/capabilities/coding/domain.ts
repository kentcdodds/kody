import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { generatedUiOAuthGuideCapability } from './generated-ui-oauth-guide.ts'
import { generatedUiSecretGuideCapability } from './generated-ui-secret-guide.ts'
import { pageToMarkdownCapability } from './page-to-markdown.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as billed page-to-markdown fallback for hard-to-read web pages, generated UI guides, and coding-agent workflows. Prefer normal fetch, browser tools, or saved skills before the billed fallback. For Cloudflare API v4 and developers.cloudflare.com doc patterns, see docs/agents/skill-patterns/.',
	capabilities: [
		generatedUiOAuthGuideCapability,
		generatedUiSecretGuideCapability,
		pageToMarkdownCapability,
	],
})
