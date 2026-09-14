import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { createEmailDestinationVerification } from '#worker/email/destination-verification.ts'
import { loadEmailDestinationAccount } from '#worker/email/destinations.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import {
	emailDestinationSchema,
	mapEmailDestinationError,
	toEmailDestination,
} from './email-destination-shared.ts'

export const emailDestinationAddCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailDestinationAdd',
		description:
			'Start verification for an additional email destination. emailSend still sends from your platform address; this only expands the allowed to set. The address cannot receive mail until the owner opens the verification link. Re-adding an unverified address resends the link. Cap is 5 extras besides the account email.',
		keywords: ['email', 'destination', 'add', 'verify', 'send'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			email: z.string().min(1),
		}),
		outputSchema: z.object({
			destination: emailDestinationSchema,
			created: z.boolean(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const account = await loadEmailDestinationAccount({
				db: ctx.env.APP_DB,
				stableUserId: user.userId,
			})
			if (!account) {
				throw new Error('Account was not found.')
			}
			try {
				const result = await createEmailDestinationVerification({
					env: ctx.env,
					userId: account.id,
					email: args.email,
					requestUrl: ctx.callerContext.baseUrl,
				})
				return {
					destination: toEmailDestination(result.destination),
					created: result.created,
					message:
						'Verification email sent. The address cannot receive emailSend mail until it is verified.',
				}
			} catch (error) {
				mapEmailDestinationError(error)
			}
		},
	},
)
