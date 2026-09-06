import {
	isFeatureEnabled,
	isFeatureGloballyEnabled,
} from '#worker/feature-flags/service.ts'

/**
 * Hard global gate for compute-overage Stripe charges. A per-user on
 * override cannot invoice while the global flag is off. A per-user off
 * override still dry-runs that account while global is on. A percentage
 * rollout is still globally on — in-bucket users charge via the per-user
 * evaluation.
 */
export async function isComputeOverageChargingEnabled(
	db: D1Database,
	userId: number | null,
): Promise<boolean> {
	const globallyEnabled = await isFeatureGloballyEnabled(
		db,
		'compute-overage-charging',
	)
	if (!globallyEnabled) return false
	if (userId === null) return true
	return isFeatureEnabled(db, 'compute-overage-charging', userId)
}
