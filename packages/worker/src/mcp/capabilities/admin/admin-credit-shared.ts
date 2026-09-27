import { z } from 'zod'
import { creditLedgerEntryKinds } from '#universal/credits.ts'
import { planNames } from '#universal/plans.ts'
import { stableUserIdSchema } from './admin-shared.ts'

export const adminCreditTargetSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Recipient account email.'),
		username: z.string().min(1).optional().describe('Recipient username.'),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

export const adminCreditWalletSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	plan: z.enum(planNames),
	eligible: z
		.boolean()
		.describe(
			'True when the effective plan is Pro and the account is credit-eligible (purchasable Pro subscription or admin eligibility): a positive balance unlocks 50× rate limits and past-include usage debits the wallet. Stock/concurrency ceilings come with the Pro subscription (not the wallet). Otherwise the balance is held without being used.',
		),
	adminCreditsEligible: z
		.boolean()
		.describe(
			'Admin-set eligibility (adminCreditEligibilitySet). Only counts while the effective plan is Pro.',
		),
	unlocked: z.boolean(),
	balanceMicroUsd: z
		.number()
		.int()
		.describe('Balance in micro-USD (1 USD = 1,000,000). May dip below 0.'),
	recent: z.array(
		z.object({
			id: z.string(),
			kind: z.enum(creditLedgerEntryKinds),
			amountMicroUsd: z.number().int(),
			description: z.string(),
			createdAt: z.string(),
			grantedByUsername: z
				.string()
				.nullable()
				.describe('Admin who granted (admin_grant entries only).'),
			note: z.string().nullable(),
		}),
	),
})
