import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	getOwnerEmailMessageById,
	listOwnerEmailAttachmentsForMessage,
	resolveMailboxReadCutoverDbUserId,
	type MailboxReadCutoverMemo,
} from '#worker/email/mailbox-read-cutover.ts'
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
			const dbUserId = await resolveMailboxReadCutoverDbUserId({
				db: ctx.env.APP_DB,
				stableUserId: user.userId,
			})
			if (dbUserId === null) {
				throw new Error('Authenticated user could not be resolved.')
			}
			const memo: MailboxReadCutoverMemo = {}
			const message = await getOwnerEmailMessageById({
				env: ctx.env,
				dbUserId,
				stableUserId: user.userId,
				messageId: args.message_id,
				memo,
			})
			if (!message) {
				throw new Error(`Email message not found: ${args.message_id}`)
			}
			const attachments = await listOwnerEmailAttachmentsForMessage({
				env: ctx.env,
				dbUserId,
				stableUserId: user.userId,
				messageId: message.id,
				memo,
			})
			return toMessageDetail(message, attachments)
		},
	},
)
