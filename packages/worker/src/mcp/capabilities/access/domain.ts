import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	accessGrantCapability,
	accessListCapability,
	accessRevokeCapability,
} from './access-grants.ts'
import {
	inviteAcceptCapability,
	inviteCreateCapability,
	inviteRevokeCapability,
} from './invites.ts'
import {
	orgCreateCapability,
	orgMemberListCapability,
	orgMemberRemoveCapability,
	orgMemberUpdateCapability,
} from './org-members.ts'
import {
	teamCreateCapability,
	teamMemberAddCapability,
	teamMemberRemoveCapability,
} from './teams.ts'

export const accessDomain = defineDomain({
	name: capabilityDomainNames.access,
	description:
		'Organization access: grants, invites, membership, and teams for the organization this request is bound to.',
	keywords: [
		'access',
		'grant',
		'invite',
		'org',
		'organization',
		'team',
		'member',
		'permission',
	],
	capabilities: [
		accessGrantCapability,
		accessRevokeCapability,
		accessListCapability,
		inviteCreateCapability,
		inviteAcceptCapability,
		inviteRevokeCapability,
		orgCreateCapability,
		orgMemberListCapability,
		orgMemberUpdateCapability,
		orgMemberRemoveCapability,
		teamCreateCapability,
		teamMemberAddCapability,
		teamMemberRemoveCapability,
	],
})
