import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import {
	planNames,
	resolveEmailResourceLimit,
} from '#worker/entitlements/plans.ts'
import {
	getUserPlan,
	readEntitlementResourceUsage,
	utcDayKey,
} from '#worker/entitlements/service.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'

const usageEntrySchema = z.object({
	count: z.number().int().nonnegative(),
	/** null = unlimited. */
	limit: z.number().int().nonnegative().nullable(),
})

export const emailUsageGetCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_usage_get',
		description:
			"Read the signed-in user's email usage and limits: stored message count, today's send and receive counts, the applicable caps, and the plan name.",
		keywords: ['email', 'usage', 'quota', 'limits', 'plan', 'metrics'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			plan: z.enum(planNames).nullable(),
			/** UTC day the send/receive counters apply to (YYYY-MM-DD). */
			day: z.string(),
			stored_messages: usageEntrySchema,
			sends_today: usageEntrySchema,
			receives_today: usageEntrySchema,
			/** Maximum raw MIME bytes per stored message. null = unlimited. */
			max_message_bytes: z.number().int().nonnegative().nullable(),
		}),
		async handler(_args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const db = ctx.env.APP_DB
			const now = new Date()
			const plan = await getUserPlan(db, {
				userId: user.userId,
				email: user.email,
			})
			const [storedMessages, sendsToday, receivesToday] = await Promise.all([
				readEntitlementResourceUsage({
					db,
					userId: user.userId,
					resource: 'stored_email_messages',
					now,
				}),
				readEntitlementResourceUsage({
					db,
					userId: user.userId,
					resource: 'email_sends_per_day',
					now,
				}),
				readEntitlementResourceUsage({
					db,
					userId: user.userId,
					resource: 'email_receives_per_day',
					now,
				}),
			])
			return {
				plan,
				day: utcDayKey(now),
				stored_messages: {
					count: storedMessages,
					limit: resolveEmailResourceLimit(plan, 'stored_email_messages'),
				},
				sends_today: {
					count: sendsToday,
					limit: resolveEmailResourceLimit(plan, 'email_sends_per_day'),
				},
				receives_today: {
					count: receivesToday,
					limit: resolveEmailResourceLimit(plan, 'email_receives_per_day'),
				},
				max_message_bytes: resolveEmailResourceLimit(
					plan,
					'email_message_bytes',
				),
			}
		},
	},
)
