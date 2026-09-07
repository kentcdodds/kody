import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { ensureReferralProgramTestSchema } from './test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { getUserEntitlement } from './service.ts'
import {
	attributeReferralAtSignup,
	isQualifyingPaidReferralInvoice,
	loadReferralProgramSummary,
	readStripeInvoicePeriodEndIso,
	maybeRewardHeldReferralAfterEmailVerified,
	rewardReferralForPaidInvoice,
} from './referral-program.ts'

const now = new Date('2026-09-07T12:00:00.000Z')
const firstCreditExpiresAt = '2026-10-07T12:00:00.000Z'
const secondCreditExpiresAt = '2026-11-06T12:00:00.000Z'

async function ensureReferralSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: [
			'email_verified_at',
			'account_type',
			'stripe_customer_id',
			'stripe_plan',
		],
	})
	await ensureReferralProgramTestSchema(db)
}

async function insertUser(
	db: D1Database,
	input: {
		email: string
		username?: string
		verified?: boolean
		plan?: string
		stripePlan?: string | null
		stripeCustomerId?: string | null
		accountType?: string
	},
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, plan, stripe_plan,
				stripe_customer_id, email_verified_at, account_type
			) VALUES (?, ?, 'hash', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.username ?? input.email.split('@')[0],
			input.email,
			stableUserId,
			input.plan ?? 'free',
			input.stripePlan ?? null,
			input.stripeCustomerId ?? null,
			input.verified === false ? null : now.toISOString(),
			input.accountType ?? 'person',
		)
		.run()
	return { email: input.email, stableUserId }
}

async function creditExpiry(db: D1Database, stableUserId: string) {
	const row = await db
		.prepare(
			`SELECT referral_standard_credit_expires_at
			 FROM users WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<{ referral_standard_credit_expires_at: string | null }>()
	return row?.referral_standard_credit_expires_at ?? null
}

async function referralRow(db: D1Database, refereeStableUserId: string) {
	return db
		.prepare(`SELECT * FROM referrals WHERE referee_stable_user_id = ?`)
		.bind(refereeStableUserId)
		.first<{
			status: string
			reward_invoice_id: string | null
			reject_reason: string | null
			held_invoice_id: string | null
		}>()
}

test('referral rewards both parties once on first paid invoice, skips trial, rejects fraud, and stacks without a cap', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureReferralSchema(db)

	const referrer = await insertUser(db, {
		email: 'referrer@example.com',
		username: 'referrer',
	})
	const referee = await insertUser(db, {
		email: 'referee@example.com',
		username: 'referee',
	})
	const unpaid = await insertUser(db, {
		email: 'unpaid@example.com',
		username: 'unpaid',
	})
	const plusTag = await insertUser(db, {
		email: 'referrer+alt@example.com',
		username: 'plustag',
	})
	const self = await insertUser(db, {
		email: 'self@example.com',
		username: 'selfuser',
	})
	const unverified = await insertUser(db, {
		email: 'unverified@example.com',
		username: 'unverified',
		verified: false,
	})

	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: referee.stableUserId,
			refereeUsername: 'referee',
			referralCode: 'referrer',
			now,
		}),
	).toEqual({ outcome: 'attributed' })
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: referee.stableUserId,
			refereeUsername: 'referee',
			referralCode: 'referrer',
			now,
		}),
	).toEqual({ outcome: 'already_attributed' })
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: unpaid.stableUserId,
			refereeUsername: 'unpaid',
			referralCode: 'referrer',
			now,
		}),
	).toEqual({ outcome: 'attributed' })
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: plusTag.stableUserId,
			refereeUsername: 'plustag',
			referralCode: 'referrer',
			now,
		}),
	).toEqual({ outcome: 'attributed' })
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: self.stableUserId,
			refereeUsername: 'selfuser',
			referralCode: 'selfuser',
			now,
		}),
	).toEqual({ outcome: 'ignored', reason: 'self' })
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: unverified.stableUserId,
			refereeUsername: 'unverified',
			referralCode: 'referrer',
			now,
		}),
	).toEqual({ outcome: 'attributed' })
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: testStableUserIdFromEmail('ghost@example.com'),
			refereeUsername: 'ghost',
			referralCode: 'nobody',
			now,
		}),
	).toEqual({ outcome: 'ignored', reason: 'unknown_referrer' })

	expect(
		isQualifyingPaidReferralInvoice({
			status: 'paid',
			amount_paid: 0,
			billing_reason: 'subscription_create',
			subscription: 'sub_trial',
		}),
	).toBe(false)
	expect(
		isQualifyingPaidReferralInvoice({
			status: 'paid',
			amount_paid: 1200,
			billing_reason: 'subscription_create',
			subscription: 'sub_paid',
		}),
	).toBe(true)
	expect(
		isQualifyingPaidReferralInvoice({
			status: 'paid',
			amount_paid: 250,
			billing_reason: 'manual',
			metadata: { kody_compute_overage: '1' },
		}),
	).toBe(false)
	expect(
		readStripeInvoicePeriodEndIso({
			lines: {
				data: [
					{ period: { end: 1_778_000_000 } },
					{ period: { end: 1_780_588_800 } },
				],
			},
		}),
	).toBe('2026-06-04T16:00:00.000Z')

	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: unpaid.stableUserId,
			invoiceId: 'in_trial',
			invoiceQualifies: false,
			now,
		}),
	).toEqual({ outcome: 'ignored', reason: 'invoice_unqualified' })
	expect(await referralRow(db, unpaid.stableUserId)).toMatchObject({
		status: 'pending',
		reward_invoice_id: null,
	})

	const firstPaid = await rewardReferralForPaidInvoice({
		db,
		refereeStableUserId: referee.stableUserId,
		invoiceId: 'in_first',
		invoiceQualifies: true,
		now,
	})
	expect(firstPaid).toEqual({ outcome: 'rewarded' })
	expect(await creditExpiry(db, referrer.stableUserId)).toBe(
		firstCreditExpiresAt,
	)
	expect(await creditExpiry(db, referee.stableUserId)).toBe(
		firstCreditExpiresAt,
	)
	expect(
		await getUserEntitlement(db, {
			userId: referrer.stableUserId,
			email: referrer.email,
		}),
	).toEqual({ plan: 'standard', ladder: 'public' })
	expect(
		await getUserEntitlement(db, {
			userId: referee.stableUserId,
			email: referee.email,
		}),
	).toEqual({ plan: 'standard', ladder: 'public' })
	expect(await referralRow(db, referee.stableUserId)).toMatchObject({
		status: 'rewarded',
		reward_invoice_id: 'in_first',
	})

	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: referee.stableUserId,
			invoiceId: 'in_second_cycle',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'already_rewarded' })
	expect(await creditExpiry(db, referrer.stableUserId)).toBe(
		firstCreditExpiresAt,
	)
	expect(await creditExpiry(db, referee.stableUserId)).toBe(
		firstCreditExpiresAt,
	)

	const secondReferee = await insertUser(db, {
		email: 'referee-two@example.com',
		username: 'refereetwo',
	})
	expect(
		await attributeReferralAtSignup({
			db,
			refereeStableUserId: secondReferee.stableUserId,
			refereeUsername: 'refereetwo',
			referralCode: 'referrer',
			now,
		}),
	).toEqual({ outcome: 'attributed' })
	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: secondReferee.stableUserId,
			invoiceId: 'in_second_friend',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'rewarded' })
	expect(await creditExpiry(db, referrer.stableUserId)).toBe(
		secondCreditExpiresAt,
	)
	expect(await creditExpiry(db, secondReferee.stableUserId)).toBe(
		firstCreditExpiresAt,
	)

	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: plusTag.stableUserId,
			invoiceId: 'in_plus',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'rejected', reason: 'same_email' })
	expect(await referralRow(db, plusTag.stableUserId)).toMatchObject({
		status: 'rejected',
		reject_reason: 'same_email',
	})
	expect(await creditExpiry(db, plusTag.stableUserId)).toBeNull()

	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: unverified.stableUserId,
			invoiceId: 'in_held',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'held_unverified' })
	expect(await referralRow(db, unverified.stableUserId)).toMatchObject({
		status: 'pending',
		held_invoice_id: 'in_held',
	})
	expect(await creditExpiry(db, unverified.stableUserId)).toBeNull()

	await db
		.prepare(`UPDATE users SET email_verified_at = ? WHERE stable_user_id = ?`)
		.bind(now.toISOString(), unverified.stableUserId)
		.run()
	expect(
		await maybeRewardHeldReferralAfterEmailVerified({
			db,
			stableUserId: unverified.stableUserId,
			now,
		}),
	).toEqual({ outcome: 'rewarded' })
	expect(await creditExpiry(db, unverified.stableUserId)).toBe(
		firstCreditExpiresAt,
	)
	expect(await referralRow(db, unverified.stableUserId)).toMatchObject({
		status: 'rewarded',
		reward_invoice_id: 'in_held',
	})
})

test('held rewards release for every pending referee when the referrer verifies', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureReferralSchema(db)
	const referrer = await insertUser(db, {
		email: 'held-referrer@example.com',
		username: 'heldreferrer',
		verified: false,
	})
	const first = await insertUser(db, {
		email: 'held-one@example.com',
		username: 'heldone',
	})
	const second = await insertUser(db, {
		email: 'held-two@example.com',
		username: 'heldtwo',
	})
	await attributeReferralAtSignup({
		db,
		refereeStableUserId: first.stableUserId,
		refereeUsername: 'heldone',
		referralCode: 'heldreferrer',
		now,
	})
	await attributeReferralAtSignup({
		db,
		refereeStableUserId: second.stableUserId,
		refereeUsername: 'heldtwo',
		referralCode: 'heldreferrer',
		now,
	})
	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: first.stableUserId,
			invoiceId: 'in_held_one',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'held_unverified' })
	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: second.stableUserId,
			invoiceId: 'in_held_two',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'held_unverified' })

	await db
		.prepare(`UPDATE users SET email_verified_at = ? WHERE stable_user_id = ?`)
		.bind(now.toISOString(), referrer.stableUserId)
		.run()
	expect(
		await maybeRewardHeldReferralAfterEmailVerified({
			db,
			stableUserId: referrer.stableUserId,
			now,
		}),
	).toEqual({ outcome: 'rewarded' })
	expect(await referralRow(db, first.stableUserId)).toMatchObject({
		status: 'rewarded',
		reward_invoice_id: 'in_held_one',
	})
	expect(await referralRow(db, second.stableUserId)).toMatchObject({
		status: 'rewarded',
		reward_invoice_id: 'in_held_two',
	})
	expect(await creditExpiry(db, referrer.stableUserId)).toBe(
		secondCreditExpiresAt,
	)
})

test('held rewards stay pending when the referrer period resolver fails', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureReferralSchema(db)
	const referrer = await insertUser(db, {
		email: 'held-fail-referrer@example.com',
		username: 'heldfailref',
		verified: false,
	})
	const referee = await insertUser(db, {
		email: 'held-fail-referee@example.com',
		username: 'heldfailree',
	})
	await attributeReferralAtSignup({
		db,
		refereeStableUserId: referee.stableUserId,
		refereeUsername: 'heldfailree',
		referralCode: 'heldfailref',
		now,
	})
	expect(
		await rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: referee.stableUserId,
			invoiceId: 'in_held_fail',
			invoiceQualifies: true,
			now,
		}),
	).toEqual({ outcome: 'held_unverified' })
	await db
		.prepare(`UPDATE users SET email_verified_at = ? WHERE stable_user_id = ?`)
		.bind(now.toISOString(), referrer.stableUserId)
		.run()
	consoleWarn.mockImplementation(() => {})
	expect(
		await maybeRewardHeldReferralAfterEmailVerified({
			db,
			stableUserId: referrer.stableUserId,
			resolveReferrerPaidPeriodEnd: async () => {
				throw new Error('stripe down')
			},
			now,
		}),
	).toEqual({ outcome: 'ignored', reason: 'no_pending' })
	expect(consoleWarn).toHaveBeenCalledWith(
		'referral-held-referrer-period-end-failed',
		expect.any(Error),
	)
	expect(await referralRow(db, referee.stableUserId)).toMatchObject({
		status: 'pending',
		held_invoice_id: 'in_held_fail',
		credits_granted_at: null,
	})
	expect(await creditExpiry(db, referrer.stableUserId)).toBeNull()
})

test('referral billing summary counts every row, not only the displayed page', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureReferralSchema(db)
	const referrer = await insertUser(db, {
		email: 'count-referrer@example.com',
		username: 'countreferrer',
	})
	for (let index = 0; index < 52; index += 1) {
		const referee = await insertUser(db, {
			email: `count-ref-${index}@example.com`,
			username: `countref${index}`,
		})
		await db
			.prepare(
				`INSERT INTO referrals (
					referrer_stable_user_id, referee_stable_user_id, created_at, status
				) VALUES (?, ?, ?, ?)`,
			)
			.bind(
				referrer.stableUserId,
				referee.stableUserId,
				now.toISOString(),
				index < 3 ? 'rewarded' : 'pending',
			)
			.run()
	}
	const summary = await loadReferralProgramSummary({
		db,
		stableUserId: referrer.stableUserId,
		username: 'countreferrer',
		origin: 'https://kody.codes',
		now,
	})
	expect(summary.rewardedCount).toBe(3)
	expect(summary.pendingCount).toBe(49)
	expect(summary.referrals).toHaveLength(50)
})
