import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { sendOutboundEmail } from '#worker/email/outbound.ts'
import { emailMessageSummarySchema, toMessageSummary } from './shared.ts'

export const emailSendCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_send',
		description:
			'Send an outbound email from a verified sender identity and store delivery audit events.',
		keywords: ['email', 'send', 'mail', 'outbound', 'sender identity'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			from: z.string().min(1),
			to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
			subject: z.string().min(1),
			text: z.string().min(1).optional(),
			html: z.string().min(1).optional(),
			reply_to: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			message: emailMessageSummarySchema,
			provider_message_id: z.string().nullable(),
			status: z.string(),
			error: z.string().nullable(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await sendOutboundEmail({
				env: ctx.env,
				userId: user.userId,
				from: args.from,
				to: args.to,
				subject: args.subject,
				text: args.text ?? null,
				html: args.html ?? null,
				replyTo: args.reply_to ?? null,
			})
			return {
				message: toMessageSummary(result.message),
				provider_message_id: result.providerMessageId,
				status: result.status,
				error: result.error,
			}
		},
	},
)
