import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { kodyOfficialGuideCapability } from './kody-official-guide.ts'

export const codingDomain = defineDomain({
	name: capabilityDomainNames.coding,
	description:
		'Official Kody guides from the repository and coding-agent workflows.',
	capabilities: [kodyOfficialGuideCapability],
})
