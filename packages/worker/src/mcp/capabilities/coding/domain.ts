import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { kodyOfficialGuideCapability } from './kody-official-guide.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Software work such as official Kody guides from the repository and coding-agent workflows. For package-oriented Cloudflare API and developer-doc patterns, see the contributor package/manifest docs and official guides.',
	capabilities: [kodyOfficialGuideCapability],
})
