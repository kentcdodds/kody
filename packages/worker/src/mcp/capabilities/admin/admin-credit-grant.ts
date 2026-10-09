import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	creditAdminGrantMaxCents,
	creditAdminGrantNoteMaxLength,
} from '#universal/credits.ts'
import {
	formatAdminCreditGrantAuditReason,
	grantAdminCreditsToUser,
} from '#worker/admin/credit-grants.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminCreditTargetSchema,
	adminCreditWalletSchema,
} from './admin-credit-shared.ts'

const inputSchema = z.intersection(
	adminCreditTargetSchema,
	z.object({
		amountCents: z
			.number()
			.int()
			.min(1)
			.max(creditAdminGrantMaxCents)
			.describe('Credits to add, in whole US cents (1000 = $10).'),
		note: z
			.string()
			.max(creditAdminGrantNoteMaxLength)
			.optional()
			.describe('Why the grant was made. Stored on the ledger entry.'),
	}),
)

const outputSchema = z.object({
	entryId: z.string(),
	amountCents: z.number().int(),
	wallet: adminCreditWalletSchema,
})

export const adminCreditGrantCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminCreditGrant',
		description:
			'Grant (add) prepaid credits to one account by stable user id, email, or username, including the calling admin. House-funded: no Stripe charge. Writes an audited ledger entry with the granting admin, amount, recipient, time, and optional note. Credits are only spent (on usage past the Pro include) by credit-eligible Pro accounts; otherwise the balance is held.',
		keywords: ['admin', 'credits', 'wallet', 'grant', 'balance', 'top up'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const admin = requireMcpUser(ctx.callerContext)
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCreditGrant',
				async () =>
					grantAdminCreditsToUser({
						env: ctx.env,
						target: {
							stableUserId: args.stableUserId,
							email: args.email,
							username: args.username,
						},
						grantedBy: { stableUserId: admin.userId, email: admin.email },
						amountCents: args.amountCents,
						note: args.note,
						path: '/mcp',
						audit: false,
					}),
				{
					successReason: (result) =>
						formatAdminCreditGrantAuditReason({
							stableUserId: result.wallet.stableUserId,
							amountCents: result.amountCents,
							entryId: result.entryId,
						}),
				},
			)
		},
	},
)
