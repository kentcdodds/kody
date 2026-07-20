import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminCommunityActivityListCapability } from './admin-community-activity-list.ts'
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'
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
		'Admin-only operator capabilities for account metadata, feature flags, operator-owned system email, attributed platform feedback users explicitly submit for admin review, and metadata about activity on public community listings; never exposes private package source or unrelated user content such as secrets, memories, jobs, or user inbox email.',
	keywords: [
		'admin',
		'rbac',
		'account metadata',
		'users',
		'roles',
		'plans',
		'audit',
		'feature flags',
		'system email',
		'platform feedback',
		'community activity',
	],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminUserCreateCapability,
		adminUserUpdateCapability,
		adminAuditLogQueryCapability,
		adminUserUsageCapability,
		adminFeatureFlagListCapability,
		adminFeatureFlagSetCapability,
		adminFeatureFlagOverrideCapability,
		adminSystemEmailListCapability,
		adminSystemEmailGetCapability,
		adminPlatformFeedbackListCapability,
		adminPlatformFeedbackGetCapability,
		adminPlatformFeedbackUpdateCapability,
		adminCommunityActivityListCapability,
	],
})
