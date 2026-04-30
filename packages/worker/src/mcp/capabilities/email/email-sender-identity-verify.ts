import { z } from 'zod'
import {
	getEmailDomain,
	requireNormalizedEmailAddress,
} from '#worker/email/address.ts'
import { upsertEmailSenderIdentity } from '#worker/email/repo.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const emailSenderIdentityVerifyOutputSchema = z.object({
	identity_id: z.string(),
})

export const emailSenderIdentityVerifyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_sender_identity_verify',
		description: 'Verify an outbound sender identity for the signed-in user.',
		keywords: ['email', 'sender', 'identity', 'verify', 'outbound'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			email: z.string().min(1),
			display_name: z.string().optional(),
		}),
		outputSchema: emailSenderIdentityVerifyOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const email = requireNormalizedEmailAddress(args.email)
			const identity = await upsertEmailSenderIdentity({
				db: ctx.env.APP_DB,
				userId: user.userId,
				email,
				domain: getEmailDomain(email),
				displayName: args.display_name ?? null,
				status: 'verified',
			})
			return {
				identity_id: identity.id,
			}
		},
	},
)
