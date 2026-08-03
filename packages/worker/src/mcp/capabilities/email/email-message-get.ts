import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	getOwnerEmailMessageById,
	listOwnerEmailAttachmentsForMessage,
} from '#worker/email/owner-email-reader.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import { emailMessageDetailSchema, toMessageDetail } from './shared.ts'

export const emailMessageGetCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_message_get',
		description:
			'Get one stored email message, including parsed bodies, headers, attachment metadata, and processing state.',
		keywords: ['email', 'message', 'get', 'headers', 'attachments'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			message_id: z.string().min(1),
		}),
		outputSchema: emailMessageDetailSchema,
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const message = await getOwnerEmailMessageById({
				env: ctx.env,
				ownerId: user.userId,
				messageId: args.message_id,
			})
			if (!message) {
				throw new Error(`Email message not found: ${args.message_id}`)
			}
			const attachments = await listOwnerEmailAttachmentsForMessage({
				env: ctx.env,
				ownerId: user.userId,
				messageId: message.id,
			})
			return toMessageDetail(message, attachments)
		},
	},
)
