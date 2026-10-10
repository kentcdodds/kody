import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { orgDeleteCapability } from './org-delete.ts'
import { orgRestoreCapability } from './org-restore.ts'
import { orgUpdateCapability } from './org-update.ts'
import { resourceRestoreCapability } from './resource-restore.ts'

export const orgsDomain = defineDomain({
	name: capabilityDomainNames.orgs,
	description:
		'Organization lifecycle: profile, soft delete, restore, and resource restore.',
	keywords: ['org', 'organization', 'team', 'soft delete', 'restore', 'purge'],
	capabilities: [
		orgUpdateCapability,
		orgDeleteCapability,
		orgRestoreCapability,
		resourceRestoreCapability,
	],
})
