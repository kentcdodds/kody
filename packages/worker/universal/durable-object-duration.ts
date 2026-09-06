/**
 * Observe-only Durable Object duration helpers for admin usage.
 *
 * Cloudflare bills DO duration in GB-seconds (active seconds × memory GB).
 * Default DO memory is 128 MB. These helpers convert recorded RPC wall-clock
 * milliseconds into that unit. They do not set includes, overage rates, or
 * customer charges.
 */

export const durableObjectDefaultMemoryGb = 0.128

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

export function formatDurableObjectGbSeconds(gbSeconds: number): string {
	const safe = Number.isFinite(gbSeconds) ? Math.max(0, gbSeconds) : 0
	if (safe === 0) return '0 GB-s'
	if (safe < 0.01) return `${safe.toFixed(4)} GB-s`
	if (safe < 1) return `${safe.toFixed(3)} GB-s`
	if (safe < 10) return `${safe.toFixed(2)} GB-s`
	return `${Math.round(safe)} GB-s`
}

export const durableObjectDurationFootnote =
	'Estimated GB-s at the default 128 MB Durable Object memory: summed RPC wall-clock seconds × 0.128. Observe-only — not billed and not a customer include.'
