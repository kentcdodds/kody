import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { kodyOfficialGuideCapability } from './kody-official-guide.ts'
import { pageToMarkdownCapability } from './page-to-markdown.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as billed page-to-markdown fallback for hard-to-read web pages, official Kody guides from the repository, and coding-agent workflows. Prefer normal fetch, browser tools, or saved skills before the billed fallback. For Cloudflare API v4 and developers.cloudflare.com doc patterns, see docs/contributing/skill-patterns/.',
	capabilities: [kodyOfficialGuideCapability, pageToMarkdownCapability],
})
