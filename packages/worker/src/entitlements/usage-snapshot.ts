import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	entitlementResourceLabels,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'
import {
	accountUsageEntitlementResources,
	entitlementResourceVisibility,
	type EntitlementResourceGroup,
	type EntitlementResourceVisibilityKind,
} from './resource-visibility.ts'
import { readCurrentEntitlementResourceUsage } from './service.ts'

export const entitlementUsageWarningThreshold = 0.8

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
}

export type EntitlementUsageSnapshot = {
	plan: PlanName
	today: string
	resources: Array<EntitlementUsageSnapshotRow>
	warnings: Array<EntitlementUsageSnapshotRow>
}

export async function readEntitlementUsageSnapshot(input: {
	db: D1Database
	env: Env
	usageUserId: string
	plan: PlanName
	now?: Date
}): Promise<EntitlementUsageSnapshot> {
	const now = input.now ?? new Date()
	const resources = await Promise.all(
		accountUsageEntitlementResources.map(async (resource) => {
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
			const limit = resolvePlanLimit(input.plan, resource)
			// per_unit_max compares one candidate value (no accumulating
			// usage) and a zero limit means the plan has no allowance, so a
			// current/limit ratio is meaningless for both.
			const percentOfLimit =
				visibility.kind === 'per_unit_max' || limit === 0
					? null
					: current / limit
			return {
				resource,
				label: entitlementResourceLabels[resource],
				group: visibility.group,
				kind: visibility.kind,
				whatCounts: visibility.whatCounts,
				howToReduce: visibility.howToReduce,
				current,
				limit,
				percentOfLimit,
				overEightyPercent:
					percentOfLimit !== null &&
					percentOfLimit > entitlementUsageWarningThreshold,
			}
		}),
	)
	return {
		plan: input.plan,
		today: utcDayKey(now),
		resources,
		warnings: resources.filter((row) => row.overEightyPercent),
	}
}
