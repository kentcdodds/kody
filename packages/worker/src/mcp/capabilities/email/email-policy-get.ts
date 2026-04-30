import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listEmailSenderPolicies } from '#worker/email/repo.ts'
import { emailPolicySchema } from './shared.ts'

export const emailPolicyGetCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_policy_get',
		description:
			'Inspect sender allow/quarantine/reject policies for the signed-in user, optionally scoped to an inbox.',
		keywords: ['email', 'policy', 'allowlist', 'quarantine', 'sender'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			inbox_id: z.string().min(1).optional(),
			include_disabled: z.boolean().default(false),
		}),
		outputSchema: z.object({
			policies: z.array(emailPolicySchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const policies = await listEmailSenderPolicies({
				db: ctx.env.APP_DB,
				userId: user.userId,
				inboxId: args.inbox_id ?? null,
				includeDisabled: args.include_disabled,
			})
			return {
				policies: policies.map((policy) => ({
					id: policy.id,
					inbox_id: policy.inboxId,
					package_id: policy.packageId,
					kind: policy.kind,
					value: policy.value,
					effect: policy.effect,
					enabled: policy.enabled,
					created_at: policy.createdAt,
					updated_at: policy.updatedAt,
				})),
			}
		},
	},
)
