/**
 * Observe-only Durable Object duration helpers for admin usage.
 *
 * Cloudflare bills DO duration in GB-seconds (active seconds × memory GB).
 * Default DO memory is 128 MB. These helpers convert recorded RPC wall-clock
 * milliseconds into that unit. They do not set includes, overage rates, or
 * customer charges.
 */

const durableObjectDefaultMemoryGb = 0.128

export function durationMsToDurableObjectGbSeconds(durationMs: number): number {
	const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
	return (safeMs / 1000) * durableObjectDefaultMemoryGb
}

export function toAdminDurableObjectDuration(input: {
	durationMs: number
	rpcCount: number
}) {
	const durationMs = Number.isFinite(input.durationMs)
		? Math.max(0, input.durationMs)
		: 0
	const rpcCount = Number.isFinite(input.rpcCount)
		? Math.max(0, Math.trunc(input.rpcCount))
		: 0
	return {
		gbSeconds: durationMsToDurableObjectGbSeconds(durationMs),
		durationMs,
		rpcCount,
		memoryGb: durableObjectDefaultMemoryGb,
	}
}

/** Cloudflare list price for DO duration (Workers Paid). */
const cloudflareDurableObjectDurationUsdPerMillionGbSeconds = 12.5

/**
 * Month-to-date Cloudflare-measured active time for one user from
 * `durable_object_duration_daily`. Gross at list: the account-wide 400,000
 * GB-s include and Cloudflare's rounding apply to the invoice total, not to
 * any one user, so this is a cost share estimate, not a bill.
 */
export function toAdminMeasuredDurableObjectDuration(
	rows: ReadonlyArray<{ doClass: string; activeMs: number; lastDay: string }>,
) {
	const byClass = rows
		.map((row) => {
			const activeMs = Number.isFinite(row.activeMs)
				? Math.max(0, row.activeMs)
				: 0
			return {
				doClass: row.doClass,
				activeMs,
				gbSeconds: durationMsToDurableObjectGbSeconds(activeMs),
			}
		})
		.sort((a, b) => b.activeMs - a.activeMs)
	const activeMs = byClass.reduce((total, row) => total + row.activeMs, 0)
	const gbSeconds = durationMsToDurableObjectGbSeconds(activeMs)
	const lastDay = rows.reduce<string | null>(
		(latest, row) =>
			latest == null || row.lastDay > latest ? row.lastDay : latest,
		null,
	)
	return {
		activeMs,
		gbSeconds,
		estimatedUsd:
			(gbSeconds / 1_000_000) *
			cloudflareDurableObjectDurationUsdPerMillionGbSeconds,
		lastDay,
		byClass,
	}
}

export function formatDurableObjectGbSeconds(gbSeconds: number): string {
	const safe = Number.isFinite(gbSeconds) ? Math.max(0, gbSeconds) : 0
	if (safe === 0) return '0 GB-s'
	if (safe < 0.01) return `${safe.toFixed(4)} GB-s`
	if (safe < 1) return `${safe.toFixed(3)} GB-s`
	if (safe < 10) return `${safe.toFixed(2)} GB-s`
	return `${Math.round(safe)} GB-s`
}

export const durableObjectDurationFootnote =
	'RPC proxy: StorageRunner RPC wall-clock seconds × 0.128. Observe-only — not billed and not a customer include.'

export const measuredDurableObjectDurationFootnote =
	"Cloudflare-measured: per-object active time from Cloudflare analytics for this user's Durable Objects, × 0.128 GB. Gross at $12.50 per million GB-s before the account-wide include — an estimate of this user's share, not an invoice line. MCP session and JobManager objects are not attributed."
