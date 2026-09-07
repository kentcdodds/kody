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
})

export const usageGetCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'usageGet',
		description:
			'Read the signed-in user’s entitlement usage against plan limits, including monthly unique worker days (Dynamic Worker isolates) and Durable Object rows-read: per-resource current, limit, percent used, and plain-language guidance on what counts and how to reduce it.',
		keywords: [
			'account',
			'usage',
			'quota',
			'limits',
			'entitlements',
			'plan',
			'unique worker days',
			'dynamic worker',
		],
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
			const entitlement = await getUserEntitlement(db, {
				userId: user.userId,
				email: user.email,
			})
			const billing = await db
				.prepare(
					user.email
						? `SELECT id, stripe_customer_id FROM users WHERE email = ? AND stable_user_id = ?`
						: `SELECT id, stripe_customer_id FROM users WHERE stable_user_id = ?`,
				)
				.bind(
					...(user.email
						? [user.email.trim().toLowerCase(), user.userId]
						: [user.userId]),
				)
				.first<{ id: number; stripe_customer_id: string | null }>()
			const [snapshot, computeOverage] = await Promise.all([
				readEntitlementUsageSnapshot({
					db,
					env: ctx.env,
					usageUserId: user.userId,
					plan: entitlement.plan,
					ladder: entitlement.ladder,
				}),
				readAccountComputeOverage({
					db,
					userId: billing?.id ?? null,
					stableUserId: user.userId,
					plan: entitlement.plan,
					ladder: entitlement.ladder,
					hasStripeCustomer: Boolean(billing?.stripe_customer_id?.trim()),
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
			})
			const computeRows = toComputeOverageUsageRows(computeOverage)
			return {
				plan: snapshot.plan,
				day: snapshot.today,
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
