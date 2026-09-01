import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { deriveWaitingItems } from '#mcp/waiting/derive-waiting.ts'
import { waitingItemKinds, waitingSeverities } from '#universal/waiting.ts'

const waitingItemSchema = z.object({
	id: z.string(),
	kind: z.enum(waitingItemKinds),
	title: z.string(),
	why: z.string(),
	who: z.literal('you'),
	do_label: z.string(),
	href: z.string(),
	severity: z.enum(waitingSeverities),
})

export const waitingSummaryCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'waitingSummary',
		description:
			'List things currently waiting on the signed-in human: email verification, MCP reconnects, locked-package publishes, plan caps, and unfinished setup. This is a current-state queue, not run history — use runSummary for Activity.',
		keywords: [
			'waiting',
			'inbox',
			'approvals',
			'blockers',
			'reconnect',
			'needs you',
			'onboarding',
			'verify email',
			'locked package',
			'MCP disconnected',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			count: z.number().int().nonnegative(),
			waiting_url: z.string(),
			items: z.array(waitingItemSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const origin = ctx.callerContext.baseUrl.replace(/\/+$/, '')
			const userRow = await ctx.env.APP_DB.prepare(
				`SELECT id, email_verified_at FROM users WHERE stable_user_id = ? LIMIT 1`,
			)
				.bind(user.userId)
				.first<{ id: number; email_verified_at: string | null }>()
			if (!userRow) {
				return {
					count: 0,
					waiting_url: `${origin}/account/waiting`,
					items: [],
				}
			}
			const items = await deriveWaitingItems({
				env: ctx.env,
				user: {
					userId: userRow.id,
					stableUserId: user.userId,
					email: user.email,
					emailVerified: Boolean(userRow.email_verified_at),
				},
			})
			return {
				count: items.length,
				waiting_url: `${origin}/account/waiting`,
				items: items.map((item) => ({
					id: item.id,
					kind: item.kind,
					title: item.title,
					why: item.why,
					who: item.who,
					do_label: item.doLabel,
					href: item.href.startsWith('http')
						? item.href
						: `${origin}${item.href}`,
					severity: item.severity,
				})),
			}
		},
	},
)
