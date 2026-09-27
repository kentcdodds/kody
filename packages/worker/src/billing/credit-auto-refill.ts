import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { decideCreditAutoRefill } from '#universal/credits.ts'
import { isBillingConfigured } from './billing-config.ts'
import {
	applyCreditPayment,
	countCreditAutoRefills,
	markCreditAutoRefillFailed,
	readCreditWallet,
	sumCreditAutoRefillCents,
} from './credit-wallet.ts'
import {
	sendCreditAutoRefilledEmail,
	sendCreditMonthlyCapEmail,
} from '#app/user-account-emails.ts'
import {
	createOffSessionPaymentIntent,
	StripeApiError,
} from './stripe-client.ts'

export const creditAutoRefillMetadataKey = 'kody_credit_auto_refill'

export type CreditAutoRefillOutcome =
	| 'charged'
	| 'skipped'
	| 'cap_reached'
	| 'failed'

/**
 * Charge one auto-refill when the wallet is at or under its threshold.
 * Callers only invoke this for wallet-eligible Pro accounts. The Stripe
 * idempotency key is per (user, month, refill number), so a retried lane
 * cannot charge the same refill twice.
 */
export async function runCreditAutoRefill(input: {
	env: Env
	userId: string
	email: string
	stripeCustomerId: string | null
	now: Date
}): Promise<CreditAutoRefillOutcome> {
	const db = input.env.APP_DB
	const month = utcMonthKey(input.now)
	const wallet = await readCreditWallet(db, input.userId)
	if (!wallet.autoRefill.enabled) return 'skipped'
	const refilledThisMonthCents = await sumCreditAutoRefillCents({
		db,
		userId: input.userId,
		month,
	})
	const customerId = input.stripeCustomerId?.trim() || null
	const decision = decideCreditAutoRefill({
		settings: wallet.autoRefill,
		balanceMicroUsd: wallet.balanceMicroUsd,
		refilledThisMonthCents,
		hasPaymentMethod: Boolean(wallet.autoRefillPaymentMethodId && customerId),
		lastFailedAt: wallet.autoRefillFailedAt,
		now: input.now,
	})
	switch (decision.action) {
		case 'skip':
			return 'skipped'
		case 'cap_reached':
			if (wallet.notify.monthlyCap) {
				await sendCreditMonthlyCapEmail({
					env: input.env,
					email: input.email,
					userId: input.userId,
					month,
				}).catch((error: unknown) => {
					console.warn('credit-monthly-cap-email-failed', error)
				})
			}
			return 'cap_reached'
		case 'charge':
			break
		default: {
			const exhaustive: never = decision
			throw new Error(`Unknown auto-refill decision: ${String(exhaustive)}`)
		}
	}
	if (!isBillingConfigured(input.env) || !customerId) return 'skipped'
	const paymentMethodId = wallet.autoRefillPaymentMethodId
	if (!paymentMethodId) return 'skipped'
	const refillNumber =
		(await countCreditAutoRefills({ db, userId: input.userId, month })) + 1
	try {
		const intent = await createOffSessionPaymentIntent(input.env, {
			customerId,
			paymentMethodId,
			amountCents: decision.amountCents,
			description: 'Kody credits auto-refill',
			idempotencyKey: `kody-credit-auto-refill:${input.userId}:${month}:${refillNumber}`,
			metadata: {
				[creditAutoRefillMetadataKey]: '1',
				kody_stable_user_id: input.userId,
			},
		})
		if (intent.status !== 'succeeded' || intent.currency !== 'usd') {
			await markCreditAutoRefillFailed({
				db,
				userId: input.userId,
				now: input.now,
			})
			return 'failed'
		}
		const result = await applyCreditPayment({
			db,
			userId: input.userId,
			kind: 'auto_refill',
			amountCents: intent.amount,
			stripeReference: intent.id,
			now: input.now,
		})
		if (result.applied && wallet.notify.autoRefilled) {
			await sendCreditAutoRefilledEmail({
				env: input.env,
				email: input.email,
				userId: input.userId,
				paymentIntentId: intent.id,
				amountCents: intent.amount,
				balanceMicroUsd: result.balanceMicroUsd,
			}).catch((error: unknown) => {
				console.warn('credit-auto-refilled-email-failed', error)
			})
		}
		return 'charged'
	} catch (error) {
		if (!(error instanceof StripeApiError)) throw error
		console.error('credit_auto_refill_failed', {
			status: error.status,
			code: error.code,
		})
		await markCreditAutoRefillFailed({
			db,
			userId: input.userId,
			now: input.now,
		})
		return 'failed'
	}
}
