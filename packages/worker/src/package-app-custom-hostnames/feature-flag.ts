import {
	isFeatureEnabled,
	isFeatureGloballyEnabled,
	isMissingFeatureFlagsTable,
} from '#worker/feature-flags/service.ts'
import { packageAppCustomDomainsFlagKey } from '#universal/feature-flags/registry.ts'

export { packageAppCustomDomainsFlagKey }

/**
 * Global on/off for custom-hostname **serving**. Anonymous visitor traffic on
 * a customer hostname has no user id, so the serve path cannot apply
 * `experiments_opt_in`. Management surfaces use
 * {@link isPackageAppCustomDomainsEnabledForUser} instead.
 *
 * Workers-unit D1 starts empty and does not apply migrations, so a missing
 * `feature_flags` table is the registry default (off) rather than a failed
 * handoff.
 */
export async function isPackageAppCustomDomainsEnabled(db: D1Database) {
	try {
		return await isFeatureGloballyEnabled(db, packageAppCustomDomainsFlagKey)
	} catch (error) {
		if (isMissingFeatureFlagsTable(error)) return false
		throw error
	}
}

/**
 * Per-user gate for add/list/sync/delete and org-settings UI. Honors
 * audience (including `experiments_opt_in`) and per-user overrides.
 */
export async function isPackageAppCustomDomainsEnabledForUser(
	db: D1Database,
	userId: number | null,
) {
	try {
		return await isFeatureEnabled(db, packageAppCustomDomainsFlagKey, userId)
	} catch (error) {
		if (isMissingFeatureFlagsTable(error)) return false
		throw error
	}
}
