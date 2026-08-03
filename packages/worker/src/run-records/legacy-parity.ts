/**
 * Content-free legacy → RunLog parity checks for production seed sweeps.
 *
 * Inputs name the rows expected in the per-user RunLog DO after a non-
 * destructive expand. Outputs are counts and a single parity boolean only —
 * never workflow names, job errors, package ids beyond the caller's input, or
 * other user-authored content.
 */

import {
	type ActivationMilestone,
	activationMilestoneValues,
} from './package-activation-state.ts'

/**
 * Hard cap for each input array on {@link verifyLegacyParity}. Oversized
 * batches fail closed rather than silently slicing.
 */
export const legacyParityVerifyMaxBatch = 500

export type LegacyParityWorkflowCheck = {
	id: string
	/**
	 * When set, a present projection whose `updatedAt` is strictly below this
	 * ISO timestamp counts as `underCount` rather than `matched`.
	 */
	minimumUpdatedAt?: string | null
}

export type LegacyParityActivationPackageCheck = {
	packageId: string
	minimumSuccessCount: number
}

export type LegacyParityVerifyInput = {
	/**
	 * Workflow projection ids. Plain strings are existence checks; objects may
	 * also require a minimum `updatedAt`.
	 */
	workflows?: Array<string | LegacyParityWorkflowCheck> | null
	/** Job ids that must exist with `legacy_seeded = 1`. */
	jobIds?: Array<string> | null
	/** Package success counters that must meet a minimum. */
	activationPackages?: Array<LegacyParityActivationPackageCheck> | null
	/** Activation milestone names that must be present. */
	activationMilestones?: Array<ActivationMilestone> | null
}

export type LegacyParityBucketCounts = {
	matched: number
	missing: number
	underCount: number
}

export type LegacyParityVerifyResult = {
	workflows: LegacyParityBucketCounts
	jobs: LegacyParityBucketCounts
	activationPackages: LegacyParityBucketCounts
	activationMilestones: LegacyParityBucketCounts
	activationInitialized: boolean
	/** True when every requested bucket has zero `missing` and `underCount`. */
	parity: boolean
}

export function emptyLegacyParityBucketCounts(): LegacyParityBucketCounts {
	return { matched: 0, missing: 0, underCount: 0 }
}

export function assertLegacyParityBoundedArray<T>(
	value: Array<T> | null | undefined,
	label: string,
	max = legacyParityVerifyMaxBatch,
): Array<T> {
	if (value == null) return []
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`)
	}
	if (value.length > max) {
		throw new Error(
			`${label} accepts at most ${max} entries (got ${value.length})`,
		)
	}
	return value
}

export function normalizeLegacyParityWorkflowCheck(
	entry: string | LegacyParityWorkflowCheck,
): LegacyParityWorkflowCheck | null {
	if (typeof entry === 'string') {
		const id = entry.trim()
		return id ? { id } : null
	}
	const id = entry.id?.trim() ?? ''
	if (!id) return null
	const minimumUpdatedAt = entry.minimumUpdatedAt?.trim() || null
	return { id, minimumUpdatedAt }
}

export function isActivationMilestoneName(
	value: string,
): value is ActivationMilestone {
	return (activationMilestoneValues as ReadonlyArray<string>).includes(value)
}

export function bucketParityHolds(counts: LegacyParityBucketCounts): boolean {
	return counts.missing === 0 && counts.underCount === 0
}
