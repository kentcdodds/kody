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

export function mergeExecuteLastSuccess(
	incoming: number | null,
	stored: number | null,
): number | null {
	return newerTimestamp(incoming, stored)
}

/**
 * Public `/` and `/status.json` start from cron-written last-success.
 * When that stored timestamp is already outside the organic window, refresh
 * from origin `GET /health/components` (cheap; never runs execute). Fresh
 * stored evidence skips the fetch so a healthy origin is not on the
 * snapshot hot path.
 */
export function shouldRefreshExecuteLastSuccess(input: {
	now: number
	storedLastSuccessAt: number | null
}): boolean {
	if (input.storedLastSuccessAt === null) return true
	return input.now - input.storedLastSuccessAt >= executeHealthOrganicFreshMs
}

export async function resolvePublicExecuteLastSuccess(input: {
	now: number
	storedLastSuccessAt: number | null
	fetchLive: () => Promise<number | null>
	readStoredAfterFetch?: () => number | null
}): Promise<{ lastSuccessAt: number | null; persist: boolean }> {
	if (!shouldRefreshExecuteLastSuccess(input)) {
		return { lastSuccessAt: input.storedLastSuccessAt, persist: false }
	}
	const live = await input.fetchLive()
	// Durable Object input gates open on this fetch, so cron or another
	// snapshot can write a newer timestamp first. Re-read before merge so
	// persist cannot rewind that write.
	const storedAfter =
		input.readStoredAfterFetch?.() ?? input.storedLastSuccessAt
	const merged = mergeExecuteLastSuccess(live, storedAfter)
	return {
		lastSuccessAt: merged,
		persist: merged !== null && merged !== storedAfter,
	}
}

export function readExecuteHealthSyntheticResult(input: {
	status: number
	body: { ok?: unknown; reason?: unknown; error?: unknown } | null
}): { ok: boolean; error?: string | null } {
	if (input.status >= 200 && input.status < 300 && input.body?.ok === true) {
		return { ok: true, error: null }
	}
	const reason =
		typeof input.body?.reason === 'string' ? input.body.reason.trim() : ''
	const message =
		typeof input.body?.error === 'string' ? input.body.error.trim() : ''
	if (reason) return { ok: false, error: reason.slice(0, 200) }
	if (message) return { ok: false, error: message.slice(0, 200) }
	return { ok: false, error: `HTTP ${String(input.status)}` }
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
	if (!input.syntheticConfigured) {
		return {
			lastSuccessAt: input.lastSuccessAt,
			lastSyntheticAttemptAt: input.lastSyntheticAttemptAt,
			lastSyntheticSuccessAt: input.lastSyntheticSuccessAt,
			lastSyntheticError: input.lastSyntheticError,
			syntheticConfigured: false,
		}
	}
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
	if (input.lastSyntheticSuccessAt !== null) {
		if (input.lastSyntheticSuccessAt === lastVerifiedAtMs) return 'synthetic'
		// The canary execute also writes the fleet heartbeat a moment later.
		// That echo is still the synthetic, not organic traffic.
		if (
			input.lastSuccessAt === lastVerifiedAtMs &&
			lastVerifiedAtMs - input.lastSyntheticSuccessAt <
				executeHealthOrganicFreshMs
		) {
			return 'synthetic'
		}
	}
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
	if (
		!input.syntheticConfigured ||
		input.lastSyntheticError === 'not-configured'
	) {
		return 'Not recently exercised. Synthetic fallback is not configured. Missing telemetry is not an outage.'
	}
	if (input.lastSyntheticError && input.source === null) {
		return `Not recently exercised. Last synthetic attempt failed; missing telemetry is not an outage. Caller-code errors are not a platform outage.`
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
