import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { cloudflareApiDocsCapability } from './cloudflare-api-docs.ts'
import { cloudflareRestCapability } from './cloudflare-rest.ts'
import { generatedUiOAuthGuideCapability } from './generated-ui-oauth-guide.ts'
import { generatedUiSecretGuideCapability } from './generated-ui-secret-guide.ts'
import { pageToMarkdownCapability } from './page-to-markdown.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as Cloudflare API calls, public Cloudflare documentation fetch (markdown), billed page-to-markdown fallback for hard-to-read web pages, generated UI guides, and coding-agent workflows. Prefer normal fetch, browser tools, or host-specific docs capabilities before the billed fallback.',
	capabilities: [
		generatedUiOAuthGuideCapability,
		generatedUiSecretGuideCapability,
		cloudflareRestCapability,
		cloudflareApiDocsCapability,
		pageToMarkdownCapability,
	],
})
