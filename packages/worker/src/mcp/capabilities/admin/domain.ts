import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminCommunityActivityListCapability } from './admin-community-activity-list.ts'
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'
import { adminPackageScopeGrantCreateCapability } from './admin-package-scope-grant-create.ts'
import { adminPackageScopeGrantListCapability } from './admin-package-scope-grant-list.ts'
import { adminPackageScopeGrantRevokeCapability } from './admin-package-scope-grant-revoke.ts'
import { adminPlatformAccountCreateCapability } from './admin-platform-account-create.ts'
import { adminPlatformFeedbackGetCapability } from './admin-platform-feedback-get.ts'
import { adminPlatformFeedbackListCapability } from './admin-platform-feedback-list.ts'
import { adminPlatformFeedbackUpdateCapability } from './admin-platform-feedback-update.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import { adminSystemEmailSenderRuleDeleteCapability } from './admin-system-email-sender-rule-delete.ts'
import { adminSystemEmailSenderRuleListCapability } from './admin-system-email-sender-rule-list.ts'
import { adminSystemEmailSenderRuleSetCapability } from './admin-system-email-sender-rule-set.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { adminAccountWriteLeaseListCapability } from './admin-account-write-lease-list.ts'
import { adminAccountWriteLeaseRepairCapability } from './admin-account-write-lease-repair.ts'

export const adminDomain = defineDomain({
	name: capabilityDomainNames.admin,
	description:
		'Admin-only operator capabilities for account metadata, platform accounts, package scope grants, feature flags, operator-owned system email, attributed platform feedback users explicitly submit for admin review, and metadata about activity on public community listings; never exposes private package source or unrelated user content such as secrets, memories, jobs, or user inbox email.',
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
		'platform accounts',
		'package scope grants',
	],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminUserCreateCapability,
		adminUserUpdateCapability,
		adminAccountWriteLeaseListCapability,
		adminAccountWriteLeaseRepairCapability,
		adminPlatformAccountCreateCapability,
		adminPackageScopeGrantCreateCapability,
		adminPackageScopeGrantRevokeCapability,
		adminPackageScopeGrantListCapability,
		adminAuditLogQueryCapability,
		adminUserUsageCapability,
		adminFeatureFlagListCapability,
		adminFeatureFlagSetCapability,
		adminFeatureFlagOverrideCapability,
		adminSystemEmailListCapability,
		adminSystemEmailGetCapability,
		adminSystemEmailSenderRuleListCapability,
		adminSystemEmailSenderRuleSetCapability,
		adminSystemEmailSenderRuleDeleteCapability,
		adminPlatformFeedbackListCapability,
		adminPlatformFeedbackGetCapability,
		adminPlatformFeedbackUpdateCapability,
		adminCommunityActivityListCapability,
	],
})
