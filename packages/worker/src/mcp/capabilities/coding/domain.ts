import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { kodyOfficialGuideCapability } from './kody-official-guide.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as official Kody guides from the repository and coding-agent workflows. For Cloudflare API v4 and developers.cloudflare.com doc patterns, see docs/contributing/skill-patterns/.',
	capabilities: [kodyOfficialGuideCapability],
})
