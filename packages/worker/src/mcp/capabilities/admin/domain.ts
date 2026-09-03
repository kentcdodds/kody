import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminCommunityActivityListCapability } from './admin-community-activity-list.ts'
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'
import { adminSignupModeGetCapability } from './admin-signup-mode-get.ts'
import { adminSignupModeSetCapability } from './admin-signup-mode-set.ts'
import { adminPackageCodemodApplyCapability } from './admin-package-codemod-apply.ts'
import { adminPackageCodemodDryRunCapability } from './admin-package-codemod-dry-run.ts'
import { adminPackageCodemodRevertCapability } from './admin-package-codemod-revert.ts'
import { adminPackageCodemodScanCapability } from './admin-package-codemod-scan.ts'
import { adminPackageScopeGrantCreateCapability } from './admin-package-scope-grant-create.ts'
import { adminPackageScopeGrantListCapability } from './admin-package-scope-grant-list.ts'
import { adminPackageScopeGrantRevokeCapability } from './admin-package-scope-grant-revoke.ts'
import { adminPlatformAccountCreateCapability } from './admin-platform-account-create.ts'
import { adminPlatformOauthAppDeleteCapability } from './admin-platform-oauth-app-delete.ts'
import { adminPlatformOauthAppListCapability } from './admin-platform-oauth-app-list.ts'
import { adminPlatformOauthAppSaveCapability } from './admin-platform-oauth-app-save.ts'
import { adminPlatformProviderMarkDeleteCapability } from './admin-platform-provider-mark-delete.ts'
import { adminPlatformProviderMarkListCapability } from './admin-platform-provider-mark-list.ts'
import { adminPlatformProviderMarkSaveCapability } from './admin-platform-provider-mark-save.ts'
import { adminPlatformFeedbackGetCapability } from './admin-platform-feedback-get.ts'
import { adminPlatformFeedbackListCapability } from './admin-platform-feedback-list.ts'
import { adminPlatformFeedbackUpdateCapability } from './admin-platform-feedback-update.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import { adminSystemEmailSendCapability } from './admin-system-email-send.ts'
import { adminSystemEmailSenderRuleDeleteCapability } from './admin-system-email-sender-rule-delete.ts'
import { adminSystemEmailSenderRuleListCapability } from './admin-system-email-sender-rule-list.ts'
import { adminSystemEmailSenderRuleSetCapability } from './admin-system-email-sender-rule-set.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { adminUserStableIdConflictCapability } from './admin-user-stable-id-conflict.ts'
import { adminUserVerifyCapability } from './admin-user-verify.ts'
import { adminAccountDeletionAbortCapability } from './admin-account-deletion-abort.ts'
import { adminAccountWriteLeaseListCapability } from './admin-account-write-lease-list.ts'
import { adminAccountWriteLeaseRepairCapability } from './admin-account-write-lease-repair.ts'
import { adminUserMeterParityCapability } from './admin-user-meter-parity.ts'
import { adminUserMeterStorageReconcileCapability } from './admin-user-meter-storage-reconcile.ts'
import { adminMailboxMaintenanceCapability } from './admin-mailbox-maintenance.ts'
import { adminReservedUsernameAddCapability } from './admin-reserved-username-add.ts'
import { adminReservedUsernameListCapability } from './admin-reserved-username-list.ts'
import { adminReservedUsernameRemoveCapability } from './admin-reserved-username-remove.ts'
import { adminUnverifiedAccountPurgeRunCapability } from './admin-unverified-account-purge-run.ts'

export const adminDomain = defineDomain({
	name: capabilityDomainNames.admin,
	description:
		'Admin-only operator tools for accounts, flags, signup gating, maintenance, and community metadata.',
	keywords: [
		'admin',
		'rbac',
		'account metadata',
		'users',
		'roles',
		'plans',
		'email verification',
		'verify',
		'audit',
		'feature flags',
		'signup mode',
		'system email',
		'platform feedback',
		'community activity',
		'platform accounts',
		'platform oauth apps',
		'provider marks',
		'package scope grants',
		'codemod',
		'package codemod',
		'fleet',
		'migration',
		'user meter',
		'parity',
		'cutover',
		'reconcile',
		'storage bytes',
		'mailbox',
		'maintenance',
		'retention',
		'unverified account purge',
		'reserved username',
	],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminUserCreateCapability,
		adminUserUpdateCapability,
		adminUserStableIdConflictCapability,
		adminUserVerifyCapability,
		adminUserMeterParityCapability,
		adminUserMeterStorageReconcileCapability,
		adminMailboxMaintenanceCapability,
		adminAccountWriteLeaseListCapability,
		adminAccountWriteLeaseRepairCapability,
		adminAccountDeletionAbortCapability,
		adminUnverifiedAccountPurgeRunCapability,
		adminPlatformAccountCreateCapability,
		adminPlatformOauthAppSaveCapability,
		adminPlatformOauthAppListCapability,
		adminPlatformOauthAppDeleteCapability,
		adminPlatformProviderMarkSaveCapability,
		adminPlatformProviderMarkListCapability,
		adminPlatformProviderMarkDeleteCapability,
		adminPackageScopeGrantCreateCapability,
		adminPackageScopeGrantRevokeCapability,
		adminPackageScopeGrantListCapability,
		adminPackageCodemodScanCapability,
		adminPackageCodemodDryRunCapability,
		adminPackageCodemodApplyCapability,
		adminPackageCodemodRevertCapability,
		adminAuditLogQueryCapability,
		adminUserUsageCapability,
		adminFeatureFlagListCapability,
		adminFeatureFlagSetCapability,
		adminFeatureFlagOverrideCapability,
		adminReservedUsernameListCapability,
		adminReservedUsernameAddCapability,
		adminReservedUsernameRemoveCapability,
		adminSignupModeGetCapability,
		adminSignupModeSetCapability,
		adminSystemEmailListCapability,
		adminSystemEmailGetCapability,
		adminSystemEmailSendCapability,
		adminSystemEmailSenderRuleListCapability,
		adminSystemEmailSenderRuleSetCapability,
		adminSystemEmailSenderRuleDeleteCapability,
		adminPlatformFeedbackListCapability,
		adminPlatformFeedbackGetCapability,
		adminPlatformFeedbackUpdateCapability,
		adminCommunityActivityListCapability,
	],
})
