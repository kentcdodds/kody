import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { followAddCapability } from './follow-add.ts'
import { followListCapability } from './follow-list.ts'
import { followRemoveCapability } from './follow-remove.ts'

export const followDomain = defineDomain({
	name: capabilityDomainNames.follow,
	description:
		'Follow or unfollow a package or plain repo by @handle/name and list the follows this org owns.',
	keywords: [
		'follow',
		'follow_repo',
		'watch',
		'subscribe',
		'unfollow',
		'follow.published',
		'follow.pushed',
	],
	capabilities: [
		followAddCapability,
		followListCapability,
		followRemoveCapability,
	],
})
