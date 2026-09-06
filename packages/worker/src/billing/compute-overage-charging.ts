import { isFeatureEnabled } from '#worker/feature-flags/service.ts'

/**
 * Hard global gate for compute-overage Stripe charges. A per-user on
 * override cannot invoice while the global flag is off. A per-user off
 * override still dry-runs that account while global is on.
 */
export async function isComputeOverageChargingEnabled(
	db: D1Database,
	userId: number | null,
): Promise<boolean> {
	const globallyEnabled = await isFeatureEnabled(
		db,
		'compute-overage-charging',
		null,
	)
	if (!globallyEnabled) return false
	if (userId === null) return true
	return isFeatureEnabled(db, 'compute-overage-charging', userId)
}
