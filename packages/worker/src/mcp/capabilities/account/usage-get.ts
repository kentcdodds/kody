import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { planNames } from '#universal/plans.ts'
import {
	computeOverageUsageWarningRows,
	readAccountComputeOverage,
	toComputeOverageUsageRows,
} from '#worker/billing/compute-overage-account.ts'
import { getUserEntitlement } from '#worker/entitlements/service.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'

const usageWeekWindowSchema = z.object({
	current: z.number().int().nonnegative(),
	limit: z.number().int().nonnegative(),
	percent: z.number().nullable(),
	overEightyPercent: z.boolean(),
})

const usageResourceSchema = z.object({
	resource: z.string(),
	label: z.string(),
	group: z.enum(['monthly', 'daily', 'counts', 'storage', 'limits']),
	kind: z.enum(['counter', 'per_unit_max']),
	whatCounts: z.string(),
	howToReduce: z.string(),
	current: z.number().int().nonnegative(),
	limit: z.number().int().nonnegative(),
	percent: z.number().nullable(),
	overEightyPercent: z.boolean(),
	mechanic: z.string().optional(),
	week: usageWeekWindowSchema.optional(),
})

export const usageGetCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'usageGet',
		description:
			'Read the signed-in user’s entitlement usage against plan limits, including monthly Worker compute and Rows read plus execute/outbound hard caps: per-resource current, limit, percent used, and plain-language guidance on what counts and how to reduce it.',
		keywords: [
			'account',
			'usage',
			'quota',
			'limits',
			'entitlements',
			'plan',
			'execute',
			'worker compute',
			'rows read',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			plan: z.enum(planNames),
			/** UTC day for daily-rate counters (YYYY-MM-DD). */
			day: z.string(),
			/** UTC Monday that starts the week for execute/outbound weekly windows. */
			weekStart: z.string(),
			resources: z.array(usageResourceSchema),
			warnings: z.array(usageResourceSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const db = ctx.env.APP_DB
			const entitlement = await getUserEntitlement(db, {
				userId: user.userId,
				email: user.email,
			})
			const [snapshot, computeOverage] = await Promise.all([
				readEntitlementUsageSnapshot({
					db,
					env: ctx.env,
					usageUserId: user.userId,
					plan: entitlement.plan,
					ladder: entitlement.ladder,
					creditWallet: entitlement.creditWallet,
				}),
				readAccountComputeOverage({
					db,
					stableUserId: user.userId,
					plan: entitlement.plan,
					ladder: entitlement.ladder,
					creditWallet: entitlement.creditWallet,
					now: new Date(),
				}),
			])
			const mapRow = (row: {
				resource: string
				label: string
				group: 'monthly' | 'daily' | 'counts' | 'storage' | 'limits'
				kind: 'counter' | 'per_unit_max'
				whatCounts: string
				howToReduce: string
				current: number
				limit: number
				percentOfLimit: number | null
				overEightyPercent: boolean
				week?: {
					current: number
					limit: number
					percentOfLimit: number | null
					overEightyPercent: boolean
				}
			}) => ({
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
				...(row.week
					? {
							week: {
								current: row.week.current,
								limit: row.week.limit,
								percent: row.week.percentOfLimit,
								overEightyPercent: row.week.overEightyPercent,
							},
						}
					: {}),
			})
			const computeRows = toComputeOverageUsageRows(computeOverage)
			return {
				plan: snapshot.plan,
				day: snapshot.today,
				weekStart: snapshot.weekStart,
				resources: [
					...computeRows.map(mapRow),
					...snapshot.resources.map(mapRow),
				],
				warnings: [
					...computeOverageUsageWarningRows(computeOverage).map(mapRow),
					...snapshot.warnings.map(mapRow),
				],
			}
		},
	},
)
