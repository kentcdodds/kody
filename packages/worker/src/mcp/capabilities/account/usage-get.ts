import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { planNames } from '#worker/entitlements/plans.ts'
import { getUserPlan } from '#worker/entitlements/service.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'

const usageResourceSchema = z.object({
	resource: z.string(),
	label: z.string(),
	group: z.enum(['daily', 'counts', 'storage', 'limits']),
	kind: z.enum(['counter', 'boolean_allowance', 'per_unit_max']),
	whatCounts: z.string(),
	howToReduce: z.string(),
	current: z.number().int().nonnegative(),
	limit: z.number().int().nonnegative(),
	percent: z.number().nullable(),
	overEightyPercent: z.boolean(),
})

export const usageGetCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'usage_get',
		description:
			'Read the signed-in user’s entitlement usage against plan limits: per-resource current, limit, percent used, and plain-language guidance on what counts and how to reduce it.',
		keywords: ['account', 'usage', 'quota', 'limits', 'entitlements', 'plan'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			plan: z.enum(planNames),
			/** UTC day for daily-rate counters (YYYY-MM-DD). */
			day: z.string(),
			resources: z.array(usageResourceSchema),
			warnings: z.array(usageResourceSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const db = ctx.env.APP_DB
			const plan = await getUserPlan(db, {
				userId: user.userId,
				email: user.email,
			})
			const snapshot = await readEntitlementUsageSnapshot({
				db,
				env: ctx.env,
				usageUserId: user.userId,
				plan,
			})
			const mapRow = (
				row: Awaited<
					ReturnType<typeof readEntitlementUsageSnapshot>
				>['resources'][number],
			) => ({
				resource: row.resource,
				label: row.label,
				group: row.group,
				kind: row.kind,
				whatCounts: row.whatCounts,
				howToReduce: row.howToReduce,
				current: row.current,
				limit: row.limit,
				percent: row.percentOfLimit,
				overEightyPercent: row.overEightyPercent,
			})
			return {
				plan: snapshot.plan,
				day: snapshot.today,
				resources: snapshot.resources.map(mapRow),
				warnings: snapshot.warnings.map(mapRow),
			}
		},
	},
)
