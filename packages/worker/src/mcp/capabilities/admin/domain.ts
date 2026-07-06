import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminUsageOverviewCapability } from './admin-usage-overview.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'

export const adminDomain = defineDomain({
	name: capabilityDomainNames.admin,
	description:
		'Admin-only operator capabilities for account metadata and system email. System email is operator-owned mail for reserved platform addresses; this domain never exposes user-owned content such as packages, secrets, memories, jobs, or user inbox email.',
	keywords: [
		'admin',
		'rbac',
		'account metadata',
		'users',
		'roles',
		'audit',
		'system email',
	],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminUserCreateCapability,
		adminAuditLogQueryCapability,
		adminUsageOverviewCapability,
		adminSystemEmailListCapability,
		adminSystemEmailGetCapability,
	],
})
