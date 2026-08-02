import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	resolveMailboxReadCutoverDbUserId,
	searchOwnerEmailMessages,
} from '#worker/email/mailbox-read-cutover.ts'
import {
	emailDeliveryStatusValues,
	emailDirectionValues,
	emailProcessingStatusValues,
} from '#worker/email/types.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import { emailMessageSummarySchema, toMessageSummary } from './shared.ts'

export const emailMessageSearchCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_message_search',
		description:
			'Search stored email messages owned by the signed-in user by case-insensitive substring match against subject, header From, and envelope sender.',
		keywords: ['email', 'message', 'inbox', 'search', 'find', 'query'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z
				.string()
				.trim()
				.min(1)
				.max(256)
				.describe(
					'Substring to match (case-insensitive) against subject, from address, and envelope sender.',
				),
			inbox_id: z.string().min(1).optional(),
			direction: z.enum(emailDirectionValues).optional(),
			processing_status: z.enum(emailProcessingStatusValues).optional(),
			delivery_status: z.enum(emailDeliveryStatusValues).optional(),
			limit: z.number().int().positive().max(100).default(25),
		}),
		outputSchema: z.object({
			messages: z.array(emailMessageSummarySchema),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const dbUserId = await resolveMailboxReadCutoverDbUserId({
				db: ctx.env.APP_DB,
				stableUserId: user.userId,
			})
			if (dbUserId === null) {
				throw new Error('Authenticated user could not be resolved.')
			}
			const messages = await searchOwnerEmailMessages({
				env: ctx.env,
				dbUserId,
				stableUserId: user.userId,
				query: args.query,
				inboxId: args.inbox_id ?? null,
				direction: args.direction ?? null,
				processingStatus: args.processing_status ?? null,
				deliveryStatus: args.delivery_status ?? null,
				limit: args.limit,
			})
			return { messages: messages.map(toMessageSummary) }
		},
	},
)
