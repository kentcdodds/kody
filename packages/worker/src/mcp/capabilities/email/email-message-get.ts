import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	getEmailMessageById,
	listEmailAttachmentsForMessage,
} from '#worker/email/repo.ts'
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
			const user = requireMcpUser(ctx.callerContext)
			const message = await getEmailMessageById({
				db: ctx.env.APP_DB,
				userId: user.userId,
				messageId: args.message_id,
			})
			if (!message) {
				throw new Error(`Email message not found: ${args.message_id}`)
			}
			const attachments = await listEmailAttachmentsForMessage({
				db: ctx.env.APP_DB,
				messageId: message.id,
			})
			return toMessageDetail(message, attachments)
		},
	},
)
