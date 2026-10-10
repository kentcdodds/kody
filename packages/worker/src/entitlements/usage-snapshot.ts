import { utcDayKey, utcWeekStart } from '@kody-internal/shared/date-keys.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	entitlementResourceLabels,
	isWeeklyComputeWindowResource,
	resolvePlanLimit,
	resolveWeeklyPlanLimit,
	type CreditWalletState,
	type EntitlementLadder,
	type EntitlementResource,
	type PlanName,
} from '#universal/plans.ts'
import {
	accountUsageEntitlementResources,
	buildEntitlementHowToReduce,
	entitlementResourceVisibility,
	type EntitlementResourceGroup,
	type EntitlementResourceVisibilityKind,
} from './resource-visibility.ts'
import {
	readCurrentEntitlementResourceUsage,
	readUserMeterEntitlementUsageSnapshot,
} from './service.ts'
import {
	dailyEntitlementResources,
	isDailyEntitlementResource,
	type DailyEntitlementResource,
} from './user-meter-do.ts'
import { listUserStorageBucketEstimates } from '#worker/storage-buckets/service.ts'

export const entitlementUsageWarningThreshold = 0.8

export type EntitlementUsageWeekWindow = {
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
}

export type EntitlementUsageSnapshotRow = {
	resource: EntitlementResource
	label: string
	group: EntitlementResourceGroup
	kind: EntitlementResourceVisibilityKind
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
	week?: EntitlementUsageWeekWindow
}

export type EntitlementUsageSnapshot = {
	plan: PlanName
	today: string
	weekStart: string
	resources: Array<EntitlementUsageSnapshotRow>
	warnings: Array<EntitlementUsageSnapshotRow>
}

const accountUsageDailyMeterResources = dailyEntitlementResources.filter(
	(resource) =>
		(accountUsageEntitlementResources as ReadonlyArray<string>).includes(
			resource,
		),
)

export async function readEntitlementUsageSnapshot(input: {
	db: D1Database
	env: Env
	usageUserId: OwnerId
	plan: PlanName
	ladder: EntitlementLadder
	creditWallet: CreditWalletState
	now?: Date
}): Promise<EntitlementUsageSnapshot> {
	const now = input.now ?? new Date()
	const weeklyResources = accountUsageDailyMeterResources.filter(
		(resource) =>
			isWeeklyComputeWindowResource(resource) &&
			resolveWeeklyPlanLimit(
				input.plan,
				resource,
				input.ladder,
				input.creditWallet,
			) !== null,
	)
	const nonMeterResources = accountUsageEntitlementResources.filter(
		(resource) =>
			!isDailyEntitlementResource(resource) && resource !== 'storage_bytes',
	)

	const [meterCounts, bucketEstimates, nonMeterUsages] = await Promise.all([
		readUserMeterEntitlementUsageSnapshot({
			db: input.db,
			env: input.env,
			userId: input.usageUserId,
			now,
			dailyResources: accountUsageDailyMeterResources,
			weeklyResources,
			includeStorageBytes: true,
		}),
		listUserStorageBucketEstimates({
			env: input.env,
			userId: input.usageUserId,
		}),
		Promise.all(
			nonMeterResources.map(async (resource) => {
				const visibility = entitlementResourceVisibility[resource]
				const current =
					visibility.kind === 'per_unit_max'
						? 0
						: await readCurrentEntitlementResourceUsage({
								db: input.db,
								env: input.env,
								userId: input.usageUserId,
								resource,
								now,
							})
				return { resource, current }
			}),
		),
	])

	const bucketEstimateTotal = bucketEstimates.reduce(
		(total, bucket) => total + (bucket.estimatedBytes ?? 0),
		0,
	)
	const nonMeterByResource = new Map(
		nonMeterUsages.map((entry) => [entry.resource, entry.current]),
	)

	const resources = accountUsageEntitlementResources.map((resource) => {
		const visibility = entitlementResourceVisibility[resource]
		const current = resolveSnapshotCurrent({
			resource,
			visibilityKind: visibility.kind,
			meterCounts,
			bucketEstimateTotal,
			nonMeterByResource,
		})
		const week = resolveSnapshotWeekWindow({
			resource,
			plan: input.plan,
			ladder: input.ladder,
			creditWallet: input.creditWallet,
			weeklyCounts: meterCounts.weekly,
		})
		const limit = resolvePlanLimit(
			input.plan,
			resource,
			input.ladder,
			input.creditWallet,
		)
		// per_unit_max compares one candidate value (no accumulating
		// usage) and a zero limit means the plan has no allowance, so a
		// current/limit ratio is meaningless for both.
		const percentOfLimit =
			visibility.kind === 'per_unit_max' || limit === 0 ? null : current / limit
		const overEightyPercent =
			(percentOfLimit !== null &&
				percentOfLimit > entitlementUsageWarningThreshold) ||
			(week?.overEightyPercent ?? false)
		return {
			resource,
			label: entitlementResourceLabels[resource],
			group: visibility.group,
			kind: visibility.kind,
			whatCounts: visibility.whatCounts,
			howToReduce: buildEntitlementHowToReduce(
				resource,
				input.plan,
				input.creditWallet,
			),
			current,
			limit,
			percentOfLimit,
			overEightyPercent,
			...(week ? { week } : {}),
		}
	})
	return {
		plan: input.plan,
		today: utcDayKey(now),
		weekStart: utcWeekStart(now),
		resources,
		warnings: resources.filter((row) => row.overEightyPercent),
	}
}

function resolveSnapshotCurrent(input: {
	resource: EntitlementResource
	visibilityKind: EntitlementResourceVisibilityKind
	meterCounts: Awaited<ReturnType<typeof readUserMeterEntitlementUsageSnapshot>>
	bucketEstimateTotal: number
	nonMeterByResource: Map<EntitlementResource, number>
}): number {
	if (input.visibilityKind === 'per_unit_max') return 0
	if (isDailyEntitlementResource(input.resource)) {
		return input.meterCounts.daily[input.resource] ?? 0
	}
	if (input.resource === 'storage_bytes') {
		return (input.meterCounts.storageBytes ?? 0) + input.bucketEstimateTotal
	}
	return input.nonMeterByResource.get(input.resource) ?? 0
}

function resolveSnapshotWeekWindow(input: {
	resource: EntitlementResource
	plan: PlanName
	ladder: EntitlementLadder
	creditWallet: CreditWalletState
	weeklyCounts: Partial<Record<DailyEntitlementResource, number>>
}): EntitlementUsageWeekWindow | undefined {
	if (!isWeeklyComputeWindowResource(input.resource)) return undefined
	const limit = resolveWeeklyPlanLimit(
		input.plan,
		input.resource,
		input.ladder,
		input.creditWallet,
	)
	if (limit === null) return undefined
	const current = input.weeklyCounts[input.resource] ?? 0
	const percentOfLimit = limit === 0 ? null : current / limit
	return {
		current,
		limit,
		percentOfLimit,
		overEightyPercent:
			percentOfLimit !== null &&
			percentOfLimit > entitlementUsageWarningThreshold,
	}
}
