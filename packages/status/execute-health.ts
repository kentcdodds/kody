/**
 * Traffic-backed MCP execute evidence for the public status page.
 *
 * Cheap per-minute probes stay as they are. A successful real MCP execute
 * completion in the previous minute is enough positive evidence to skip a
 * synthetic. Otherwise the status worker runs at most one authenticated
 * MCP execute per rolling hour. Failed attempts consume that budget.
 *
 * Missing or stale telemetry is unknown / not recently exercised — not an
 * outage and not proof the path is freshly healthy. One organic success
 * does not override other measured component incidents.
 */

export const executeHealthOrganicFreshMs = 60_000
export const executeHealthSyntheticCooldownMs = 60 * 60 * 1000

type ExecuteHealthSource = 'organic' | 'synthetic'
type ExecuteHealthStatus = 'recent' | 'unknown'

export type ExecuteHealthSnapshot = {
	status: ExecuteHealthStatus
	source: ExecuteHealthSource | null
	lastVerifiedAt: string | null
	freshnessMs: number | null
	detail: string
}

export type ExecuteHealthCoordinatorState = {
	lastSuccessAt: number | null
	lastSyntheticAttemptAt: number | null
	lastSyntheticSuccessAt: number | null
	lastSyntheticError: string | null
	syntheticConfigured: boolean
}

export function decideExecuteHealthProbe(input: {
	now: number
	lastSuccessAt: number | null
	lastSyntheticAttemptAt: number | null
}): 'skip' | 'run' {
	if (
		input.lastSuccessAt !== null &&
		input.now - input.lastSuccessAt < executeHealthOrganicFreshMs
	) {
		return 'skip'
	}
	if (
		input.lastSyntheticAttemptAt !== null &&
		input.now - input.lastSyntheticAttemptAt < executeHealthSyntheticCooldownMs
	) {
		return 'skip'
	}
	return 'run'
}

export function claimExecuteHealthSynthetic(input: {
	now: number
	lastSuccessAt: number | null
	lastSyntheticAttemptAt: number | null
}): {
	run: boolean
	lastSyntheticAttemptAt: number | null
} {
	if (decideExecuteHealthProbe(input) === 'skip') {
		return {
			run: false,
			lastSyntheticAttemptAt: input.lastSyntheticAttemptAt,
		}
	}
	return {
		run: true,
		lastSyntheticAttemptAt: input.now,
	}
}

export function countExecuteHealthSynthetics(input: {
	ticks: ReadonlyArray<number>
	lastSuccessAt: number | null
	initialLastSyntheticAttemptAt?: number | null
}): number {
	let lastSyntheticAttemptAt = input.initialLastSyntheticAttemptAt ?? null
	let runs = 0
	for (const now of input.ticks) {
		const claim = claimExecuteHealthSynthetic({
			now,
			lastSuccessAt: input.lastSuccessAt,
			lastSyntheticAttemptAt,
		})
		lastSyntheticAttemptAt = claim.lastSyntheticAttemptAt
		if (claim.run) runs += 1
	}
	return runs
}

export async function applyExecuteHealthTick(input: {
	now: number
	lastSuccessAt: number | null
	lastSyntheticAttemptAt: number | null
	lastSyntheticSuccessAt: number | null
	lastSyntheticError: string | null
	syntheticConfigured: boolean
	runSynthetic: () => Promise<{ ok: boolean; error?: string | null }>
}): Promise<ExecuteHealthCoordinatorState> {
	const claim = claimExecuteHealthSynthetic({
		now: input.now,
		lastSuccessAt: input.lastSuccessAt,
		lastSyntheticAttemptAt: input.lastSyntheticAttemptAt,
	})
	if (!claim.run) {
		return {
			lastSuccessAt: input.lastSuccessAt,
			lastSyntheticAttemptAt: claim.lastSyntheticAttemptAt,
			lastSyntheticSuccessAt: input.lastSyntheticSuccessAt,
			lastSyntheticError: input.lastSyntheticError,
			syntheticConfigured: input.syntheticConfigured,
		}
	}
	const result = await input.runSynthetic()
	return {
		lastSuccessAt: input.lastSuccessAt,
		lastSyntheticAttemptAt: claim.lastSyntheticAttemptAt,
		lastSyntheticSuccessAt: result.ok
			? input.now
			: input.lastSyntheticSuccessAt,
		lastSyntheticError: result.ok ? null : (result.error ?? 'probe-failed'),
		syntheticConfigured: input.syntheticConfigured,
	}
}

export function deriveExecuteHealthView(
	input: ExecuteHealthCoordinatorState & { now: number },
): ExecuteHealthSnapshot {
	const lastVerifiedAtMs = newerTimestamp(
		input.lastSuccessAt,
		input.lastSyntheticSuccessAt,
	)
	const source = executeHealthSource(input, lastVerifiedAtMs)
	const freshnessMs =
		lastVerifiedAtMs === null ? null : Math.max(0, input.now - lastVerifiedAtMs)
	const recent =
		freshnessMs !== null && freshnessMs < executeHealthOrganicFreshMs
	return {
		status: recent ? 'recent' : 'unknown',
		source: lastVerifiedAtMs === null ? null : source,
		lastVerifiedAt:
			lastVerifiedAtMs === null
				? null
				: new Date(lastVerifiedAtMs).toISOString(),
		freshnessMs,
		detail: executeHealthDetail({
			...input,
			recent,
			source: lastVerifiedAtMs === null ? null : source,
			freshnessMs,
		}),
	}
}

function newerTimestamp(
	left: number | null,
	right: number | null,
): number | null {
	if (left === null) return right
	if (right === null) return left
	return Math.max(left, right)
}

function executeHealthSource(
	input: Pick<
		ExecuteHealthCoordinatorState,
		'lastSuccessAt' | 'lastSyntheticSuccessAt'
	>,
	lastVerifiedAtMs: number | null,
): ExecuteHealthSource | null {
	if (lastVerifiedAtMs === null) return null
	if (input.lastSyntheticSuccessAt === lastVerifiedAtMs) return 'synthetic'
	if (input.lastSuccessAt === lastVerifiedAtMs) return 'organic'
	return null
}

function executeHealthDetail(input: {
	recent: boolean
	source: ExecuteHealthSource | null
	freshnessMs: number | null
	lastSyntheticAttemptAt: number | null
	lastSyntheticError: string | null
	syntheticConfigured: boolean
}): string {
	if (input.recent && input.source === 'organic') {
		return `Verified by organic MCP execute traffic ${formatFreshness(input.freshnessMs)}.`
	}
	if (input.recent && input.source === 'synthetic') {
		return `Verified by the hourly authenticated MCP execute probe ${formatFreshness(input.freshnessMs)}.`
	}
	if (input.lastSyntheticError) {
		return `Not recently exercised. Last synthetic attempt failed; missing telemetry is not an outage. Caller-code errors are not a platform outage.`
	}
	if (!input.syntheticConfigured) {
		return 'Not recently exercised. Synthetic fallback is not configured. Missing telemetry is not an outage.'
	}
	return 'Not recently exercised. Missing or stale telemetry is not an outage and is not proof the path is freshly healthy.'
}

function formatFreshness(freshnessMs: number | null): string {
	if (freshnessMs === null) return 'just now'
	if (freshnessMs < 1_000) return 'just now'
	if (freshnessMs < 60_000) {
		const seconds = Math.floor(freshnessMs / 1_000)
		return `${String(seconds)}s ago`
	}
	const minutes = Math.floor(freshnessMs / 60_000)
	return `${String(minutes)}m ago`
}
