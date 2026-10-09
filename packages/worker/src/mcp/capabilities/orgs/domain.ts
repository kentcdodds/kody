import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { orgDeleteCapability } from './org-delete.ts'
import { orgRestoreCapability } from './org-restore.ts'
import { resourceRestoreCapability } from './resource-restore.ts'

export const orgsDomain = defineDomain({
	name: capabilityDomainNames.orgs,
	description:
		'Organization lifecycle: soft delete, restore, and resource restore.',
	keywords: ['org', 'organization', 'team', 'soft delete', 'restore', 'purge'],
	capabilities: [
		orgDeleteCapability,
		orgRestoreCapability,
		resourceRestoreCapability,
	],
})
