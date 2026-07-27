import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { setEmailMessageClassification } from '#worker/email/repo.ts'
import { emailClassificationValues } from '#worker/email/types.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'

export const emailMessageClassifyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_message_classify',
		description:
			'Reclassify a stored inbound email message as accepted or quarantined. Receive-time classification decides package subscription dispatch once; reclassifying to accepted does not retroactively fire email.message.received.',
		keywords: [
			'email',
			'message',
			'classify',
			'quarantine',
			'spam',
			'accepted',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			message_id: z.string().min(1),
			classification: z.enum(emailClassificationValues),
		}),
		outputSchema: z.object({
			message_id: z.string(),
			classification: z.enum(emailClassificationValues),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const classificationReason =
				args.classification === 'quarantined' ? 'Reclassified by user.' : null
			const updated = await setEmailMessageClassification({
				db: ctx.env.APP_DB,
				userId: user.userId,
				messageId: args.message_id,
				classification: args.classification,
				classificationReason,
			})
			if (!updated) {
				throw new Error(`Email message not found: ${args.message_id}`)
			}
			return {
				message_id: args.message_id,
				classification: args.classification,
			}
		},
	},
)
