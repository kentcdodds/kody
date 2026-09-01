import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { deriveWaitingItemsForStableUser } from '#mcp/waiting/derive-waiting.ts'
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
			'List things currently waiting on the signed-in human: email verification, OAuth reconnects, expired secrets, MCP reconnects, locked-package publishes, plan caps, and unfinished setup. This is a current-state queue, not run history — use runSummary for Activity. Vendor outages do not appear here.',
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
			'expired secret',
			'oauth',
			'integration',
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
			const items = await deriveWaitingItemsForStableUser({
				env: ctx.env,
				stableUserId: user.userId,
				email: user.email,
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
