/**
 * Dedicated exposure writes for flags with
 * `exposureRecording: 'paid-ranked-search'` (currently `jev-search-rerank`).
 *
 * The experiment frame is paid users who run list-mode **ranked** search:
 * - on = flag evaluates enabled (Jev-eligible; necessity may still skip Score)
 * - off = flag evaluates disabled (comparable control)
 * - free / anonymous / unresolved accounts: no exposure (outside the frame)
 *
 * Callers must pass the same `FeatureFlagEvaluation` used to drive search so
 * exposure assignment cannot disagree with treatment. Assignment source still
 * tags override dogfood for exclusion from on/off cohort comparisons.
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
import { type FeatureFlagEvaluation } from './service.ts'

export type PaidRankedSearchExposureInput = {
	env: FeatureFlagExposureEnv
	stableUserId: string | null | undefined
	planEligible: boolean
	/** Same evaluation that gated the ranked-search Jev path. */
	evaluation: FeatureFlagEvaluation
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
		const stableUserId = normalizeStableUserId(input.stableUserId ?? '')
		if (!stableUserId) return
		const flagKey = input.flagKey ?? jevSearchRerankFlagKey
		if (getFeatureFlagExposureRecording(flagKey) !== 'paid-ranked-search') {
			return
		}
		await recordFeatureFlagExposures(input.env, {
			stableUserId,
			evaluations: { [flagKey]: input.evaluation },
			recordingSite: 'dedicated',
		})
	} catch (error) {
		console.warn('paid-ranked-search-exposure-failed', error)
	}
}
