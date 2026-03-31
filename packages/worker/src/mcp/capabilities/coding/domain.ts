import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { cloudflareApiDocsCapability } from './cloudflare-api-docs.ts'
import { cloudflareRestCapability } from './cloudflare-rest.ts'
import { generatedUiOAuthGuideCapability } from './generated-ui-oauth-guide.ts'
import { generatedUiSecretGuideCapability } from './generated-ui-secret-guide.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as Cloudflare API calls, public Cloudflare documentation fetch (markdown), generated UI guides, and coding-agent workflows.',
	capabilities: [
		generatedUiOAuthGuideCapability,
		generatedUiSecretGuideCapability,
		cloudflareRestCapability,
		cloudflareApiDocsCapability,
	],
})
