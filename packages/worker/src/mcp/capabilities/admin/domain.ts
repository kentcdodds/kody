import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminPlatformFeedbackGetCapability } from './admin-platform-feedback-get.ts'
import { adminPlatformFeedbackListCapability } from './admin-platform-feedback-list.ts'
import { adminPlatformFeedbackUpdateCapability } from './admin-platform-feedback-update.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'

export const adminDomain = defineDomain({
	name: capabilityDomainNames.admin,
	description:
		'Admin-only operator capabilities for account metadata, operator-owned system email, and attributed platform feedback users explicitly submit for admin review; never exposes unrelated user content such as packages, secrets, memories, jobs, or user inbox email.',
	keywords: [
		'admin',
		'rbac',
		'account metadata',
		'users',
		'roles',
		'plans',
		'audit',
		'system email',
		'platform feedback',
	],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminUserCreateCapability,
		adminUserUpdateCapability,
		adminAuditLogQueryCapability,
		adminUserUsageCapability,
		adminSystemEmailListCapability,
		adminSystemEmailGetCapability,
		adminPlatformFeedbackListCapability,
		adminPlatformFeedbackGetCapability,
		adminPlatformFeedbackUpdateCapability,
	],
})
