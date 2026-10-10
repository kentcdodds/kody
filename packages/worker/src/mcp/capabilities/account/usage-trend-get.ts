import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { userMeterDailyCounterRetentionDays } from '#worker/entitlements/user-meter-do.ts'
import { readAccountUsageTrend } from '#worker/entitlements/usage-trend.ts'

const usageTrendDaySchema = z.object({
	/** UTC day key (`YYYY-MM-DD`). */
	day: z.string(),
	/** Hosted MCP execute count for that UTC day. */
	execute: z.number().int().nonnegative(),
	/** Unique Dynamic Worker first-claim count for that UTC day. */
	uniqueWorkerDays: z.number().int().nonnegative(),
	/** Job runs recorded in UserMeter that UTC day. */
	jobRuns: z.number().int().nonnegative().optional(),
	/** Automation invocations recorded in UserMeter that UTC day. */
	automationInvocations: z.number().int().nonnegative().optional(),
	/**
	 * Package export calls are monthly in `usage_rollups` only — not present
	 * on the daily UserMeter series.
	 */
	packageExports: z.number().int().nonnegative().optional(),
})

const usageTrendMonthSchema = z.object({
	/** UTC month key (`YYYY-MM`). */
	month: z.string(),
	execute: z.number().int().nonnegative(),
	uniqueWorkerDays: z.number().int().nonnegative(),
})

export const usageTrendGetCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'usageTrendGet',
		orgPermission: 'billing:read',
		description:
			'Read the signed-in user’s recent daily usage trend for hosted execute and unique Worker days (plus optional job/automation daily counts), with a cheap monthly rollup series from usage_rollups for charts.',
		keywords: [
			'account',
			'usage',
			'trend',
			'history',
			'chart',
			'daily',
			'execute',
			'unique worker days',
			'quota',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			days: z.array(usageTrendDaySchema),
			months: z.array(usageTrendMonthSchema).optional(),
			/** UserMeter daily counter retention window in UTC days. */
			retentionDays: z.number().int().positive(),
			/** ISO timestamp when the series was read. */
			asOf: z.string(),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const trend = await readAccountUsageTrend({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: personalOrgId(user.userId),
			})
			return {
				days: trend.days.map((day) => ({
					day: day.day,
					execute: day.execute,
					uniqueWorkerDays: day.uniqueWorkerDays,
					...(day.jobRuns > 0 ? { jobRuns: day.jobRuns } : {}),
					...(day.automationInvocations > 0
						? { automationInvocations: day.automationInvocations }
						: {}),
				})),
				months: trend.months,
				retentionDays:
					trend.retentionDays || userMeterDailyCounterRetentionDays,
				asOf: trend.asOf,
			}
		},
	},
)
