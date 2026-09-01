/**
 * Cloudflare Dynamic Worker list price used for operator cost estimates.
 *
 * Cloudflare bills $0.002 per unique worker id per UTC day, with 1,000
 * unique worker-days included per account per month. The included allotment
 * is account-wide, so per-user estimates are always gross (unique days ×
 * list price) and do not subtract a share of the included bucket.
 */

export const dynamicWorkerUsdPerUniqueDay = 0.002
export const dynamicWorkersIncludedPerAccountMonth = 1000

export function estimateDynamicWorkerUsd(uniqueWorkerDays: number): number {
	const safeDays = Number.isFinite(uniqueWorkerDays)
		? Math.max(0, uniqueWorkerDays)
		: 0
	return safeDays * dynamicWorkerUsdPerUniqueDay
}

export function toAdminDynamicWorkerCost(uniqueWorkerDays: number) {
	const safeDays = Number.isFinite(uniqueWorkerDays)
		? Math.max(0, Math.trunc(uniqueWorkerDays))
		: 0
	return {
		uniqueWorkerDays: safeDays,
		estimatedGrossUsd: estimateDynamicWorkerUsd(safeDays),
		usdPerUniqueDay: dynamicWorkerUsdPerUniqueDay,
		includedPerAccountMonth: dynamicWorkersIncludedPerAccountMonth,
	}
}

const usdFormatter = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 3,
})

/** Format a Dynamic Worker cost so $0.002 stays visible. */
export function formatDynamicWorkerUsd(amount: number): string {
	return usdFormatter.format(amount)
}

export const dynamicWorkerCostFootnote =
	'Gross estimate: unique Dynamic Worker ids × $0.002 per UTC day. Cloudflare includes 1,000 unique worker-days per account per month, so this is not a net bill share.'
