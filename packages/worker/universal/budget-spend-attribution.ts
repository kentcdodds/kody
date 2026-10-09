/**
 * Org budget MTD attribution weights from daily usage rows.
 *
 * Weights are past-include (overage) only: the month's include is consumed
 * day-by-day org-wide, then remaining billable units are priced and split by
 * that day's actor/automation share — same include walk as package credit
 * attribution, keyed by actor instead of package.
 */
import { creditDebitCostMicroUsd, type CreditDebitMeter } from './credits.ts'

export type BudgetSpendAttributionDailyUnit = {
	day: string
	meter: CreditDebitMeter
	actorUserId: string
	automationSource: string
	units: number
}

export type BudgetSpendAttributionInclude = {
	meter: CreditDebitMeter
	include: number
}

export type BudgetSpendAttributionShare = {
	actorUserId: string | null
	automationSource: string | null
	weight: number
}

function nonNegative(value: number) {
	if (!Number.isFinite(value) || value <= 0) return 0
	return value
}

/**
 * Build actor/automation weights from daily attribution units after applying
 * monthly include. Empty when nothing is past include.
 */
export function buildBudgetSpendActorWeights(input: {
	dailyUnits: ReadonlyArray<BudgetSpendAttributionDailyUnit>
	includes: ReadonlyArray<BudgetSpendAttributionInclude>
}): Array<BudgetSpendAttributionShare> {
	const remainingInclude = new Map<CreditDebitMeter, number>()
	for (const entry of input.includes) {
		remainingInclude.set(entry.meter, nonNegative(entry.include))
	}

	const days = [...new Set(input.dailyUnits.map((row) => row.day))].sort()
	const merged = new Map<string, BudgetSpendAttributionShare>()

	for (const day of days) {
		const dayMeterKeys = new Set(
			input.dailyUnits
				.filter((row) => row.day === day && row.units > 0)
				.map((row) => row.meter),
		)
		for (const meter of dayMeterKeys) {
			const dayRows = input.dailyUnits.filter(
				(row) => row.day === day && row.meter === meter && row.units > 0,
			)
			if (dayRows.length === 0) continue
			const dayTotal = dayRows.reduce((sum, row) => sum + row.units, 0)
			const remaining = remainingInclude.get(meter) ?? 0
			const covered = Math.min(remaining, dayTotal)
			remainingInclude.set(meter, remaining - covered)
			const billable = dayTotal - covered
			if (billable <= 0 || dayTotal <= 0) continue
			const dayCredits = creditDebitCostMicroUsd(meter, billable)
			if (dayCredits <= 0) continue

			let attributed = 0
			for (let index = 0; index < dayRows.length; index += 1) {
				const row = dayRows[index]!
				const share = row.units / dayTotal
				const isLast = index === dayRows.length - 1
				const credits = isLast
					? dayCredits - attributed
					: Math.floor(dayCredits * share)
				attributed += credits
				if (credits <= 0) continue

				const automation = row.automationSource.trim()
				const actor = row.actorUserId.trim()
				const shareRow: BudgetSpendAttributionShare =
					automation.length > 0
						? {
								actorUserId: null,
								automationSource: automation,
								weight: credits,
							}
						: actor.length > 0
							? {
									actorUserId: actor,
									automationSource: null,
									weight: credits,
								}
							: { actorUserId: null, automationSource: null, weight: 0 }
				if (shareRow.weight <= 0) continue
				if (shareRow.actorUserId == null && shareRow.automationSource == null) {
					continue
				}
				const key =
					shareRow.automationSource != null
						? `automation:${shareRow.automationSource}`
						: `user:${shareRow.actorUserId}`
				const existing = merged.get(key)
				if (existing) {
					existing.weight += shareRow.weight
				} else {
					merged.set(key, shareRow)
				}
			}
		}
	}

	return [...merged.values()]
}
