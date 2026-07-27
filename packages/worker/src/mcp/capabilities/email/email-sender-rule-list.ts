import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { listEmailSenderRules } from '#worker/email/sender-rules.ts'
import { requireVerifiedEmailAccountUser } from './require-verified-user.ts'
import { emailSenderRuleSchema, toSenderRule } from './shared.ts'

export const emailSenderRuleListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'email_sender_rule_list',
		description:
			'List sender allow/block/quarantine rules for the signed-in user. Inbound mail is classified at receive time using these rules (address beats domain; subdomain suffix matching) before Authentication-Results (SPF/DKIM/DMARC).',
		keywords: [
			'email',
			'sender',
			'rule',
			'allowlist',
			'blocklist',
			'spam',
			'quarantine',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			rules: z.array(emailSenderRuleSchema),
		}),
		async handler(_args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const rules = await listEmailSenderRules({
				db: ctx.env.APP_DB,
				userId: user.userId,
			})
			return { rules: rules.map(toSenderRule) }
		},
	},
)
