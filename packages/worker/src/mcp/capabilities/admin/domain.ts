import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'

export const adminDomain = defineDomain({
	name: capabilityDomainNames.admin,
	description:
		'Admin-only account metadata capabilities for user and role administration. This domain never exposes user content such as packages, secrets, memories, jobs, or email.',
	keywords: ['admin', 'rbac', 'account metadata', 'users', 'roles', 'audit'],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminAuditLogQueryCapability,
	],
})
