import { z } from 'zod'
import {
	getEmailDomain,
	normalizeEmailAddress,
	requireNormalizedEmailAddress,
} from '#worker/email/address.ts'
import {
	upsertEmailSenderIdentity,
	upsertEmailSenderPolicy,
} from '#worker/email/repo.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { senderApprovalSchema } from './shared.ts'

export const emailSenderApproveCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_sender_approve',
		description:
			'Approve an outbound sender identity or allow an inbound sender/domain for a Kody email inbox.',
		keywords: ['email', 'sender', 'approve', 'allowlist', 'identity'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			email: z.string().min(1).optional(),
			domain: z.string().min(1).optional(),
			inbox_id: z.string().min(1).optional(),
			display_name: z.string().optional(),
			mode: z
				.enum(['sender_identity', 'allow_sender', 'allow_domain'])
				.default('allow_sender'),
		}),
		outputSchema: senderApprovalSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			if (args.mode === 'sender_identity') {
				if (!args.email) throw new Error('email is required for sender identity approval.')
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
					policy: null,
				}
			}
			const kind = args.mode === 'allow_domain' ? 'domain' : 'sender'
			const value =
				kind === 'domain'
					? (args.domain ?? (args.email ? getEmailDomain(args.email) : '')).trim().toLowerCase()
					: (normalizeEmailAddress(args.email ?? '') ?? '')
			if (!value) throw new Error(`${kind} approval requires a valid value.`)
			const policy = await upsertEmailSenderPolicy({
				db: ctx.env.APP_DB,
				userId: user.userId,
				inboxId: args.inbox_id ?? null,
				kind,
				value,
				effect: 'allow',
			})
			return {
				identity_id: null,
				policy: {
					id: policy.id,
					inbox_id: policy.inboxId,
					package_id: policy.packageId,
					kind: policy.kind,
					value: policy.value,
					effect: policy.effect,
					enabled: policy.enabled,
					created_at: policy.createdAt,
					updated_at: policy.updatedAt,
				},
			}
		},
	},
)
