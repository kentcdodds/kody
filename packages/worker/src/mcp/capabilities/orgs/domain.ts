import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { orgDeleteCapability } from './org-delete.ts'
import { orgRestoreCapability } from './org-restore.ts'
import { orgUpdateCapability } from './org-update.ts'
import { resourceRestoreCapability } from './resource-restore.ts'
import { packageAppCustomHostnameAddCapability } from './package-app-custom-hostname-add.ts'
import { packageAppCustomHostnameDeleteCapability } from './package-app-custom-hostname-delete.ts'
import { packageAppCustomHostnameListCapability } from './package-app-custom-hostname-list.ts'

export const orgsDomain = defineDomain({
	name: capabilityDomainNames.orgs,
	description:
		'Organization lifecycle: profile, soft delete, restore, resource restore, and package-app custom domains.',
	keywords: [
		'org',
		'organization',
		'team',
		'soft delete',
		'restore',
		'purge',
		'custom domain',
		'hostname',
	],
	capabilities: [
		orgUpdateCapability,
		orgDeleteCapability,
		orgRestoreCapability,
		resourceRestoreCapability,
		packageAppCustomHostnameAddCapability,
		packageAppCustomHostnameListCapability,
		packageAppCustomHostnameDeleteCapability,
	],
})
