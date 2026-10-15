import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { followAddCapability } from './follow-add.ts'
import { followListCapability } from './follow-list.ts'

export const followDomain = defineDomain({
	name: capabilityDomainNames.follow,
	description:
		'Follow a package or plain repo by @handle/name and list the follows this org owns.',
	keywords: [
		'follow',
		'follow_repo',
		'watch',
		'subscribe',
		'follow.published',
		'follow.pushed',
	],
	capabilities: [followAddCapability, followListCapability],
})
