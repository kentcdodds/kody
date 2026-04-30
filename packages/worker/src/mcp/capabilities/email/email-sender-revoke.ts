import { z } from 'zod'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { disableEmailSenderPolicy } from '#worker/email/repo.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emailPolicyKindSchema, revokePolicyOutputSchema } from './shared.ts'

export const emailSenderRevokeCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_sender_revoke',
		description:
			'Revoke a sender, domain, or reply-token allow/quarantine/reject policy for the signed-in user.',
		keywords: ['email', 'sender', 'revoke', 'policy', 'allowlist'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			kind: emailPolicyKindSchema.describe('Policy kind to revoke.'),
			value: z.string().min(1).describe('Policy value to revoke.'),
			inbox_id: z
				.string()
				.min(1)
				.optional()
				.describe('Optional inbox id for inbox-scoped policy.'),
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe('Optional package id for package-scoped policy.'),
		}),
		outputSchema: revokePolicyOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const normalizedValue =
				args.kind === 'sender'
					? normalizeEmailAddress(args.value)
					: args.value.trim().toLowerCase()
			if (!normalizedValue) {
				throw new Error('Policy value must be a valid sender or domain.')
			}
			const revoked = await disableEmailSenderPolicy({
				db: ctx.env.APP_DB,
				userId: user.userId,
				kind: args.kind,
				value: normalizedValue,
				inboxId: args.inbox_id ?? null,
				packageId: args.package_id ?? null,
			})
			return { revoked }
		},
	},
)
