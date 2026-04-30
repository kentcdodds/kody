import PostalMime from 'postal-mime'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	getEmailAttachmentById,
	getEmailMessageById,
} from '#worker/email/repo.ts'

function toBase64(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

const emailAttachmentContentSchema = z.object({
	id: z.string(),
	message_id: z.string(),
	filename: z.string().nullable(),
	content_type: z.string().nullable(),
	content_id: z.string().nullable(),
	disposition: z.string().nullable(),
	size: z.number(),
	data_base64: z.string(),
})

export const emailAttachmentGetCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_attachment_get',
		description:
			'Get one stored email attachment by id, returning metadata plus the attachment bytes as base64.',
		keywords: ['email', 'attachment', 'get', 'download'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			attachment_id: z.string().min(1),
		}),
		outputSchema: emailAttachmentContentSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const attachment = await getEmailAttachmentById({
				db: ctx.env.APP_DB,
				userId: user.userId,
				attachmentId: args.attachment_id,
			})
			if (!attachment) {
				throw new Error(`Email attachment not found: ${args.attachment_id}`)
			}
			const message = await getEmailMessageById({
				db: ctx.env.APP_DB,
				userId: user.userId,
				messageId: attachment.messageId,
			})
			if (!message) {
				throw new Error(`Email message not found for attachment: ${args.attachment_id}`)
			}
			if (!message.rawMime) {
				throw new Error(
					`Email attachment "${args.attachment_id}" is unavailable because the stored message has no raw MIME payload.`,
				)
			}
			const parsed = await PostalMime.parse(message.rawMime, {
				attachmentEncoding: 'arraybuffer',
			})
			const matched = parsed.attachments.find((_candidate, index) => {
				const candidate = parsed.attachments[index]
				if (!candidate) return false
				if (candidate.filename !== attachment.filename) return false
				if (candidate.mimeType !== (attachment.contentType ?? candidate.mimeType)) {
					return false
				}
				if ((candidate.contentId ?? null) !== attachment.contentId) return false
				if ((candidate.disposition ?? null) !== attachment.disposition) return false
				const content = candidate.content
				const size =
					typeof content === 'string'
						? new TextEncoder().encode(content).byteLength
						: content.byteLength
				return size === attachment.size
			})
			if (!matched) {
				throw new Error(
					`Email attachment "${args.attachment_id}" could not be reconstructed from stored raw MIME.`,
				)
			}
			const bytes =
				typeof matched.content === 'string'
					? new TextEncoder().encode(matched.content)
					: new Uint8Array(matched.content)
			return {
				id: attachment.id,
				message_id: attachment.messageId,
				filename: attachment.filename,
				content_type: attachment.contentType,
				content_id: attachment.contentId,
				disposition: attachment.disposition,
				size: attachment.size,
				data_base64: toBase64(bytes),
			}
		},
	},
)
