import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { cloudflareRestCapability } from './cloudflare-rest.ts'
import { generatedUiOAuthGuideCapability } from './generated-ui-oauth-guide.ts'
import { generatedUiSecretGuideCapability } from './generated-ui-secret-guide.ts'
import { pageToMarkdownCapability } from './page-to-markdown.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as Cloudflare API calls, billed page-to-markdown fallback for hard-to-read web pages, generated UI guides, and coding-agent workflows. Prefer normal fetch, browser tools, or saved docs-fetch skills before the billed fallback. For developers.cloudflare.com reading patterns, see docs/agents/skill-patterns/cloudflare-developer-docs.md.',
	capabilities: [
		generatedUiOAuthGuideCapability,
		generatedUiSecretGuideCapability,
		cloudflareRestCapability,
		pageToMarkdownCapability,
	],
})
