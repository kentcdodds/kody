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

export type CoercedLegacyParityMinimumUpdatedAt =
	| { status: 'absent' }
	| { status: 'valid'; iso: string }
	| { status: 'invalid' }

export type NormalizedLegacyParityWorkflowCheck = {
	id: string
	minimumUpdatedAt: CoercedLegacyParityMinimumUpdatedAt
}

/**
 * Normalize a workflow inventory check. Blank/absent `minimumUpdatedAt` stays
 * existence-only; nonempty values are coerced to a canonical UTC ISO timestamp
 * or marked invalid so the DO can fail closed as `underCount`.
 */
export function normalizeLegacyParityWorkflowCheck(
	entry: string | LegacyParityWorkflowCheck,
): NormalizedLegacyParityWorkflowCheck | null {
	if (typeof entry === 'string') {
		const id = entry.trim()
		return id ? { id, minimumUpdatedAt: { status: 'absent' } } : null
	}
	const id = entry.id?.trim() ?? ''
	if (!id) return null
	return {
		id,
		minimumUpdatedAt: coerceLegacyParityMinimumUpdatedAt(
			entry.minimumUpdatedAt,
		),
	}
}

/**
 * Coerce a workflow `minimumUpdatedAt` threshold.
 *
 * - `null` / `undefined` / blank-or-whitespace string → absent (existence-only)
 * - nonempty parseable UTC ISO with a real calendar date → canonical `.toISOString()`
 * - everything else (including `'0'`, junk, impossible dates, non-strings) → invalid
 */
export function coerceLegacyParityMinimumUpdatedAt(
	value: unknown,
): CoercedLegacyParityMinimumUpdatedAt {
	if (value == null) return { status: 'absent' }
	if (typeof value !== 'string') return { status: 'invalid' }
	const trimmed = value.trim()
	if (!trimmed) return { status: 'absent' }
	// Require an explicit UTC offset marker so values like `"0"` cannot parse.
	if (!/(?:Z|[+-]00:00)$/i.test(trimmed)) {
		return { status: 'invalid' }
	}
	const calendarMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T/)
	if (!calendarMatch?.[1] || !calendarMatch[2] || !calendarMatch[3]) {
		return { status: 'invalid' }
	}
	const year = Number.parseInt(calendarMatch[1], 10)
	const month = Number.parseInt(calendarMatch[2], 10)
	const day = Number.parseInt(calendarMatch[3], 10)
	const reconstructed = new Date(Date.UTC(year, month - 1, day))
	if (
		reconstructed.getUTCFullYear() !== year ||
		reconstructed.getUTCMonth() !== month - 1 ||
		reconstructed.getUTCDate() !== day
	) {
		return { status: 'invalid' }
	}
	const ms = Date.parse(trimmed)
	if (!Number.isFinite(ms)) return { status: 'invalid' }
	return { status: 'valid', iso: new Date(ms).toISOString() }
}

export function isActivationMilestoneName(
	value: string,
): value is ActivationMilestone {
	return (activationMilestoneValues as ReadonlyArray<string>).includes(value)
}

export function bucketParityHolds(counts: LegacyParityBucketCounts): boolean {
	return counts.missing === 0 && counts.underCount === 0
}

/**
 * Build a bounded `IN (?, …)` placeholder list. Empty and over-cap counts fail
 * closed so callers never emit an unbounded SQL parameter list.
 */
export function legacyParitySqlInPlaceholders(
	count: number,
	max = legacyParityVerifyMaxBatch,
): string {
	if (!Number.isInteger(count) || count <= 0 || count > max) {
		throw new Error(
			`legacyParitySqlInPlaceholders count must be 1..${max} (got ${String(count)})`,
		)
	}
	return Array.from({ length: count }, () => '?').join(', ')
}

/**
 * Coerce an activation package minimum. Accepts finite `number` runtime values
 * only — `null`, blank/whitespace strings, `false`, objects, `NaN`, and
 * infinities fail closed so the caller can count `underCount`.
 */
export function coerceLegacyParityMinimumSuccessCount(
	value: unknown,
): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null
	return Math.max(0, Math.trunc(value))
}
