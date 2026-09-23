/**
 * Dedicated exposure writes for flags with
 * `exposureRecording: 'paid-ranked-search'` (currently `jev-search-rerank`).
 *
 * The experiment frame is paid users who run list-mode ranked search:
 * - on = flag evaluates enabled (Jev-eligible; necessity may still skip Score)
 * - off = flag evaluates disabled (comparable control)
 * - free / anonymous / unresolved accounts: no exposure (outside the frame)
 *
 * Assignment source still comes from flag evaluation so override dogfood is
 * tagged and excluded from on/off cohort comparisons in the admin readout.
 */

import {
	getFeatureFlagExposureRecording,
	jevSearchRerankFlagKey,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import {
	recordFeatureFlagExposures,
	type FeatureFlagExposureEnv,
} from './exposure.ts'
import { evaluateFeatureFlag } from './service.ts'

export type PaidRankedSearchExposureInput = {
	env: FeatureFlagExposureEnv & { APP_DB?: D1Database }
	stableUserId: string | null | undefined
	planEligible: boolean
	/** Override for tests; defaults to the Jev search flag. */
	flagKey?: FeatureFlagKey
}

/**
 * Record one paid ranked-search exposure when the caller is plan-eligible.
 * Never throws: search must not fail because attribution failed.
 */
export async function recordPaidRankedSearchFlagExposure(
	input: PaidRankedSearchExposureInput,
): Promise<void> {
	try {
		if (!input.planEligible) return
		const db = input.env.APP_DB
		if (!db || typeof db.prepare !== 'function') return
		const stableUserId = normalizeStableUserId(input.stableUserId ?? '')
		if (!stableUserId) return
		const flagKey = input.flagKey ?? jevSearchRerankFlagKey
		if (getFeatureFlagExposureRecording(flagKey) !== 'paid-ranked-search') {
			return
		}
		const row = await db
			.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
			.bind(stableUserId)
			.first<{ id: number }>()
		if (!row) return
		const evaluation = await evaluateFeatureFlag(db, flagKey, row.id)
		await recordFeatureFlagExposures(input.env, {
			stableUserId,
			evaluations: { [flagKey]: evaluation },
			recordingSite: 'dedicated',
		})
	} catch (error) {
		console.warn('paid-ranked-search-exposure-failed', error)
	}
}
