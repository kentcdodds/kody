import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	buildComputeOverageHowToReduce,
	computeMonthlyOverage,
	computeOverageBillingPolicy,
	computeOverageIncludePercent,
	computeOverageResourceVisibility,
	computeOverageWarningResourceLabels,
	resolveComputeOverageDisposition,
	type ComputeOverageDisposition,
	type ComputeOverageWarningResource,
} from '#universal/compute-overage.ts'
import { type EntitlementLadder, type PlanName } from '#universal/plans.ts'
import { type AccountUsageComputeOverage } from '#universal/loader-data.ts'
import { isComputeOverageChargingEnabled } from './compute-overage-charging.ts'
import { readMonthlyComputeUsage } from './compute-overage-usage.ts'

export type ComputeOverageUsageRow = {
	resource: ComputeOverageWarningResource
	label: string
	group: 'monthly'
	kind: 'counter'
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number
	overEightyPercent: boolean
}

export async function readAccountComputeOverage(input: {
	db: D1Database
	userId: number | null
	stableUserId: string
	plan: PlanName
	ladder: EntitlementLadder
	hasStripeCustomer: boolean
	now: Date
}): Promise<AccountUsageComputeOverage> {
	const month = utcMonthKey(input.now)
	const [usage, chargingEnabled] = await Promise.all([
		readMonthlyComputeUsage({
			db: input.db,
			stableUserId: input.stableUserId,
			month,
		}),
		isComputeOverageChargingEnabled(input.db, input.userId),
	])
	const overage = computeMonthlyOverage({
		plan: input.plan,
		ladder: input.ladder,
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	const uniqueWorkerDayPercent =
		computeOverageIncludePercent(
			usage.uniqueWorkerDays,
			overage.includedUniqueWorkerDays,
		) ?? 0
	const durableObjectRowsReadPercent =
		computeOverageIncludePercent(
			usage.durableObjectRowsRead,
			overage.includedDurableObjectRowsRead,
		) ?? 0
	const disposition = resolveComputeOverageDisposition({
		plan: input.plan,
		ladder: input.ladder,
		overage,
		hasStripeCustomer: input.hasStripeCustomer,
		chargingEnabled,
		policy: computeOverageBillingPolicy,
	})
	return {
		meters: [
			toComputeMeter({
				resource: 'unique_worker_days',
				current: usage.uniqueWorkerDays,
				include: overage.includedUniqueWorkerDays,
				percentOfLimit: uniqueWorkerDayPercent,
				disposition,
			}),
			toComputeMeter({
				resource: 'durable_object_rows_read',
				current: usage.durableObjectRowsRead,
				include: overage.includedDurableObjectRowsRead,
				percentOfLimit: durableObjectRowsReadPercent,
				disposition,
			}),
		],
		disposition,
		totalCents: overage.totalCents,
		chargingEnabled,
		hasStripeCustomer: input.hasStripeCustomer,
		legacyUnbilled: overage.legacyUnbilled,
	}
}

export function toComputeOverageUsageRows(
	overage: AccountUsageComputeOverage,
): Array<ComputeOverageUsageRow> {
	return overage.meters.map((meter) => ({
		resource: meter.resource,
		label: meter.label,
		group: 'monthly',
		kind: 'counter',
		whatCounts: meter.whatCounts,
		howToReduce: meter.howToReduce,
		current: meter.current,
		limit: meter.include,
		percentOfLimit: meter.percentOfLimit,
		overEightyPercent: meter.overEightyPercent,
	}))
}

export function computeOverageUsageWarningRows(
	overage: AccountUsageComputeOverage,
): Array<ComputeOverageUsageRow> {
	return toComputeOverageUsageRows(overage).filter(
		(row) => row.overEightyPercent,
	)
}

function toComputeMeter(input: {
	resource: ComputeOverageWarningResource
	current: number
	include: number
	percentOfLimit: number
	disposition: ComputeOverageDisposition
}) {
	const visibility = computeOverageResourceVisibility[input.resource]
	return {
		resource: input.resource,
		label: computeOverageWarningResourceLabels[input.resource],
		whatCounts: visibility.whatCounts,
		howToReduce: buildComputeOverageHowToReduce(
			input.resource,
			input.percentOfLimit >= 1 ? input.disposition : 'skip_zero',
		),
		current: input.current,
		include: input.include,
		percentOfLimit: input.percentOfLimit,
		overEightyPercent: input.percentOfLimit >= 0.8,
	}
}
