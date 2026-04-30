import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listEmailMessages } from '#worker/email/repo.ts'
import { emailMessageSummarySchema, toMessageSummary } from './shared.ts'

export const emailMessageListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_message_list',
		description:
			'List stored inbound, quarantined, and outbound email messages owned by the signed-in user.',
		keywords: ['email', 'message', 'inbox', 'quarantine', 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			inbox_id: z.string().min(1).optional(),
			direction: z.enum(['inbound', 'outbound']).optional(),
			processing_status: z.enum(['stored', 'sent', 'failed', 'rejected']).optional(),
			policy_decision: z
				.enum(['accepted', 'quarantined', 'rejected'])
				.optional(),
			limit: z.number().int().positive().max(100).default(25),
		}),
		outputSchema: z.object({
			messages: z.array(emailMessageSummarySchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const messages = await listEmailMessages({
				db: ctx.env.APP_DB,
				userId: user.userId,
				inboxId: args.inbox_id ?? null,
				direction: args.direction ?? null,
				processingStatus: args.processing_status ?? null,
				policyDecision: args.policy_decision ?? null,
				limit: args.limit,
			})
			return { messages: messages.map(toMessageSummary) }
		},
	},
)
