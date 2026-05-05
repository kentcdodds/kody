import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { sendOutboundEmail } from '#worker/email/outbound.ts'
import { getEmailMessageById } from '#worker/email/repo.ts'
import {
	emailMessageSummarySchema,
	stringArray,
	toMessageSummary,
} from './shared.ts'

export const emailReplyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_reply',
		description:
			'Reply to a stored inbound email using a verified sender identity, preserving thread headers.',
		keywords: ['email', 'reply', 'thread', 'message'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				message_id: z.string().min(1),
				from: z.string().email(),
				text: z.string().min(1).optional(),
				html: z.string().min(1).optional(),
			})
			.refine((value) => value.text !== undefined || value.html !== undefined, {
				message: 'Email text or HTML body is required.',
				path: ['text'],
			}),
		outputSchema: emailMessageSummarySchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const original = await getEmailMessageById({
				db: ctx.env.APP_DB,
				userId: user.userId,
				messageId: args.message_id,
			})
			if (!original)
				throw new Error(`Email message not found: ${args.message_id}`)
			const fromAddress =
				stringArray(original.replyToAddresses)[0] ??
				original.fromAddress ??
				original.envelopeFrom
			if (!fromAddress)
				throw new Error('Original message has no reply address.')
			const result = await sendOutboundEmail({
				env: ctx.env,
				userId: user.userId,
				from: args.from,
				to: fromAddress,
				subject: original.subject?.toLowerCase().startsWith('re:')
					? original.subject
					: `Re: ${original.subject ?? '(no subject)'}`,
				text: args.text ?? null,
				html: args.html ?? null,
				inReplyToHeader: original.messageIdHeader ?? null,
				references: [
					...stringArray(original.references),
					...(original.messageIdHeader ? [original.messageIdHeader] : []),
				],
				threadId: original.threadId,
				inboxId: original.inboxId,
			})
			return toMessageSummary(result.message)
		},
	},
)
