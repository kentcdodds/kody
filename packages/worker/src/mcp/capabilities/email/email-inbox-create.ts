import { z } from 'zod'
import {
	createReplyToken,
	getEmailDomain,
	getEmailLocalPart,
	hashReplyToken,
	requireNormalizedEmailAddress,
} from '#worker/email/address.ts'
import { createEmailInboxWithAddress } from '#worker/email/repo.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emailInboxCreateOutputSchema, emailInboxModeSchema } from './shared.ts'

export const emailInboxCreateCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_inbox_create',
		description:
			'Create a storage-only email inbox and routable alias for the signed-in user. Unknown senders are quarantined by default.',
		keywords: ['email', 'inbox', 'alias', 'routing', 'quarantine'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z.string().trim().min(1),
			address: z.string().email(),
			description: z.string().optional(),
			mode: emailInboxModeSchema.default('quarantine'),
		}),
		outputSchema: emailInboxCreateOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const address = requireNormalizedEmailAddress(
				args.address,
				'Inbox address',
			)
			const replyToken = createReplyToken()
			const { inbox, address: alias } = await createEmailInboxWithAddress({
				db: ctx.env.APP_DB,
				userId: user.userId,
				ownerEmail: user.email,
				ownerDisplayName: user.displayName,
				name: args.name.trim(),
				description: args.description?.trim() ?? '',
				mode: args.mode,
				address,
				localPart: getEmailLocalPart(address),
				domain: getEmailDomain(address),
				replyTokenHash: await hashReplyToken(replyToken),
			})
			return {
				id: inbox.id,
				name: inbox.name,
				description: inbox.description,
				mode: inbox.mode,
				enabled: inbox.enabled,
				addresses: [
					{
						id: alias.id,
						address: alias.address,
						reply_token_hash: alias.replyTokenHash,
						reply_token: replyToken,
						enabled: alias.enabled,
						created_at: alias.createdAt,
					},
				],
				created_at: inbox.createdAt,
				updated_at: inbox.updatedAt,
			}
		},
	},
)
