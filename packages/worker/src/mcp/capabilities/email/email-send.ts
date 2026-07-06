import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import { sendOutboundEmail } from '#worker/email/outbound.ts'
import { emailMessageSummarySchema, toMessageSummary } from './shared.ts'

const emailSendInputSchema = z
	.object({
		to: z
			.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
			.optional(),
		subject: z.string().min(1),
		text: z.string().min(1).optional(),
		html: z.string().min(1).optional(),
		reply_to: z.string().min(1).optional(),
	})
	.refine((value) => value.text || value.html, {
		message: 'Email text or HTML body is required.',
		path: ['text'],
	})

export const emailSendCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_send',
		description:
			'Send a notification email to your own account email address. The from address is your platform-assigned {username}@<platform domain>; any other recipient is rejected (use email_reply to answer stored inbound mail).',
		keywords: ['email', 'send', 'mail', 'outbound', 'notify'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: emailSendInputSchema,
		outputSchema: z.object({
			message: emailMessageSummarySchema,
			provider_message_id: z.string().nullable(),
			status: z.string(),
			error: z.string().nullable(),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const result = await sendOutboundEmail({
				env: ctx.env,
				userId: user.userId,
				accountEmail: user.email,
				recipientPolicy: 'self',
				to: args.to ?? null,
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
