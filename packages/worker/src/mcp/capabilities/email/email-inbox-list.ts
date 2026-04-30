import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	listEmailInboxAddressesForUser,
	listEmailInboxesForUser,
} from '#worker/email/repo.ts'
import { emailInboxListSchema } from './shared.ts'

export const emailInboxListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_inbox_list',
		description:
			'List email inboxes and routable aliases owned by the signed-in user.',
		keywords: ['email', 'inbox', 'alias', 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: emailInboxListSchema,
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const [inboxes, addresses] = await Promise.all([
				listEmailInboxesForUser({ db: ctx.env.APP_DB, userId: user.userId }),
				listEmailInboxAddressesForUser({
					db: ctx.env.APP_DB,
					userId: user.userId,
				}),
			])
			return {
				inboxes: inboxes.map((inbox) => ({
					id: inbox.id,
					name: inbox.name,
					description: inbox.description,
					enabled: inbox.enabled,
					addresses: addresses
						.filter((address) => address.inboxId === inbox.id)
						.map((address) => ({
							id: address.id,
							address: address.address,
							reply_token_hash: address.replyTokenHash,
							enabled: address.enabled,
							created_at: address.createdAt,
						})),
					created_at: inbox.createdAt,
					updated_at: inbox.updatedAt,
				})),
			}
		},
	},
)
