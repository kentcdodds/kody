/**
 * Content-free per-owner RunLog read of failed runs in a time window.
 *
 * The RunLog Durable Object classifies `error_message` itself and returns only
 * package ids, counts, and `started_at` bounds — never messages, names, logs,
 * inputs, or results.
 */

/**
 * Fixed substrings of the refusals the fetch gateway and local execute raised
 * while a secret placeholder was filled only in a request header (or only in
 * the header a `kody.credentials` slot declared). That rule is gone, so these
 * texts match only runs recorded while it was live. Plain-HTTP and
 * disallowed-host refusals are excluded: those still apply.
 */
export const headerOnlyPlacementRefusalMarkers = [
	'The fetch gateway substitutes a secret only into a request header',
	'The fetch gateway never substitutes a secret into a request body',
	'so the fetch gateway never substitutes it.',
	'so the fetch gateway does not substitute it:',
	'A package that declares kody.credentials substitutes only its declared slots.',
	'A package that declares kody.credentials sends one slot per header.',
	'may only be sent in its declared header',
	'value does not match that template.',
	'but a Basic Auth pair is sent as',
	'must be exactly "Basic ',
] as const

/** Bound on `packageIds` so one RunLog query stays within SQLite bindings. */
export const packageFailureSummaryMaxPackageIds = 50

export type RunLogPackageFailureSummaryInput = {
	/** Inclusive ISO lower bound on `started_at`. */
	since: string
	/** Exclusive ISO upper bound on `started_at`. */
	until: string
	/** Packages whose every failed run is counted, whatever the error. */
	packageIds: Array<string>
}

export type RunLogFailureCounts = {
	count: number
	firstAt: string | null
	lastAt: string | null
}

export type RunLogPackageFailureSummaryRow = {
	/** Null for runs with no package (for example ad-hoc execute). */
	packageId: string | null
	placementRefusals: RunLogFailureCounts
	/** Null when `packageId` was not in the requested `packageIds`. */
	failedRuns: RunLogFailureCounts | null
}

export type RunLogPackageFailureSummary = {
	packages: Array<RunLogPackageFailureSummaryRow>
}

export const emptyRunLogFailureCounts: RunLogFailureCounts = {
	count: 0,
	firstAt: null,
	lastAt: null,
}
