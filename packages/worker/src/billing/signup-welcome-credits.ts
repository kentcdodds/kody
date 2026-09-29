/**
 * One-shot $5 welcome credits for newly created person accounts. Lives
 * outside `credit-wallet.ts` so the debit/auto-refill graph (runtime worker)
 * does not carry signup-only grant code.
 */
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	microUsdPerCent,
	signupWelcomeCreditCents,
	signupWelcomeCreditLedgerId,
	signupWelcomeCreditNote,
} from '#universal/credits.ts'
import { getUserEntitlement } from '#worker/entitlements/service.ts'
import {
	forgiveUnchargedCreditUsage,
	readCreditWallet,
} from './credit-wallet.ts'

export type SignupWelcomeCreditResult = {
	applied: boolean
	entryId: string
	balanceMicroUsd: number
	createdAt: string
}

function isUniqueConstraintError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /UNIQUE constraint failed/i.test(message)
}

/**
 * House-funded welcome credits via the `admin_grant` ledger path, with a
 * deterministic entry id so retries never double-grant. `granted_by_user_id`
 * is null (platform signup, not an admin actor). Does not unlock spend —
 * Free and non-eligible accounts hold the balance until credit-eligible Pro.
 */
export async function grantSignupWelcomeCredits(input: {
	db: D1Database
	userId: string
	now?: Date
}): Promise<SignupWelcomeCreditResult> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const amountMicroUsd = signupWelcomeCreditCents * microUsdPerCent
	const entryId = signupWelcomeCreditLedgerId(input.userId)
	const walletBefore = await readCreditWallet(input.db, input.userId)
	if (walletBefore.balanceMicroUsd <= 0) {
		await forgiveUnchargedCreditUsage({
			db: input.db,
			userId: input.userId,
			entitlement: await getUserEntitlement(input.db, {
				userId: input.userId,
				email: null,
			}),
			now,
		})
	}
	try {
		await input.db.batch([
			input.db
				.prepare(
					`INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
					 VALUES (?, ?, ?)`,
				)
				.bind(input.userId, nowIso, nowIso),
			input.db
				.prepare(
					`INSERT INTO credit_ledger_entries
						(id, user_id, kind, amount_micro_usd, month, granted_by_user_id, note, created_at)
					 VALUES (?, ?, 'admin_grant', ?, ?, NULL, ?, ?)`,
				)
				.bind(
					entryId,
					input.userId,
					amountMicroUsd,
					utcMonthKey(now),
					signupWelcomeCreditNote,
					nowIso,
				),
			input.db
				.prepare(
					`UPDATE credit_wallets
					 SET balance_micro_usd = balance_micro_usd + ?, updated_at = ?
					 WHERE user_id = ?`,
				)
				.bind(amountMicroUsd, nowIso, input.userId),
		])
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error
		const wallet = await readCreditWallet(input.db, input.userId)
		return {
			applied: false,
			entryId,
			balanceMicroUsd: wallet.balanceMicroUsd,
			createdAt: nowIso,
		}
	}
	const wallet = await readCreditWallet(input.db, input.userId)
	return {
		applied: true,
		entryId,
		balanceMicroUsd: wallet.balanceMicroUsd,
		createdAt: nowIso,
	}
}

/**
 * Best-effort wrapper for account-creation sites. Signup must not fail when
 * the welcome grant cannot run (fake test DBs, transient D1 errors); the
 * deterministic ledger id still makes a later retry safe.
 */
export async function maybeGrantSignupWelcomeCredits(input: {
	db: D1Database
	userId: string
	now?: Date
}): Promise<SignupWelcomeCreditResult | null> {
	try {
		return await grantSignupWelcomeCredits(input)
	} catch (error) {
		console.warn('signup-welcome-credits-failed', error)
		return null
	}
}
