import { isFeatureGloballyEnabled } from '#worker/feature-flags/service.ts'
import { packageAppCustomDomainsFlagKey } from '#universal/feature-flags/registry.ts'

export { packageAppCustomDomainsFlagKey }

/**
 * Global on/off for custom-hostname serving. Workers-unit D1 starts empty and
 * does not apply migrations, so a missing `feature_flags` table is the
 * registry default (off) rather than a failed handoff.
 */
export async function isPackageAppCustomDomainsEnabled(db: D1Database) {
	try {
		return await isFeatureGloballyEnabled(db, packageAppCustomDomainsFlagKey)
	} catch (error) {
		if (isMissingFeatureFlagsTable(error)) return false
		throw error
	}
}

function isMissingFeatureFlagsTable(error: unknown) {
	const message = error instanceof Error ? error.message : ''
	const cause =
		error instanceof Error && error.cause instanceof Error
			? error.cause.message
			: ''
	return `${message} ${cause}`.includes('no such table: feature_flags')
}
