import { expect, test, vi } from 'vitest'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import {
	AccountDeletionBillingError,
	deleteUserAccount,
} from './account-deletion.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import {
	createStripeUserDb,
	kodyCreditNote,
	paidInvoice,
	refundPeriodEnd,
	refundPeriodMidpointMs,
	refundPeriodStart,
	spyOnStripeRefundClient,
	stripeSubscription,
	thirtyDaysSeconds,
} from '#worker/test-support/account-deletion-billing.ts'

function spyOnStripeBillingClient() {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi
		.spyOn(stripeClient, 'cancelSubscription')
		.mockResolvedValue(undefined)
	const deleteCustomer = vi
		.spyOn(stripeClient, 'deleteCustomer')
		.mockResolvedValue(undefined)
	const refund = spyOnStripeRefundClient()
	return {
		listSubscriptions,
		cancelSubscription,
		deleteCustomer,
		...refund,
		restore() {
			listSubscriptions.mockRestore()
			cancelSubscription.mockRestore()
			deleteCustomer.mockRestore()
			refund.restore()
		},
	}
}

function subscriptionIdsOf(calls: Array<[unknown, string, ...Array<unknown>]>) {
	return calls.map(([, subscriptionId]) => subscriptionId)
}

test('account deletion cancels Stripe billing before cleanup and keeps customer deletion best-effort', async () => {
	const stripe = spyOnStripeBillingClient()
	try {
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
			stripeSubscription('sub_trialing', 'trialing'),
			// Dunning and paused states can still invoice or resume, so they
			// must be canceled too; only terminal states are skipped.
			stripeSubscription('sub_past_due', 'past_due'),
			stripeSubscription('sub_unpaid', 'unpaid'),
			stripeSubscription('sub_paused', 'paused'),
			stripeSubscription('sub_incomplete', 'incomplete'),
			stripeSubscription('sub_canceled', 'canceled'),
			stripeSubscription('sub_expired', 'incomplete_expired'),
		])
		const { db, rows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-pro',
			customerId: 'cus_pro',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-pro',
		})

		expect(stripe.listSubscriptions).toHaveBeenCalledTimes(1)
		expect(stripe.listSubscriptions).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_pro',
		)
		expect(stripe.cancelSubscription).toHaveBeenCalledTimes(6)
		expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).toEqual([
			'sub_active',
			'sub_trialing',
			'sub_past_due',
			'sub_unpaid',
			'sub_paused',
			'sub_incomplete',
		])
		expect(stripe.deleteCustomer).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_pro',
		)
		expect(rows.users).toEqual([])
		expect(result.warnings).toEqual([])
		// Only subscriptions in good standing are even considered for a refund;
		// with no paid invoice there is nothing to credit.
		expect(
			subscriptionIdsOf(stripe.listPaidInvoicesForSubscription.mock.calls),
		).toEqual(['sub_active', 'sub_trialing'])
		expect(stripe.createProratedRefundCreditNote).not.toHaveBeenCalled()
		expect(stripe.listCreditNotesForCustomer).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_pro',
		)
		expect(result.stripeRefunds).toEqual([])

		// Customer deletion after a successful cancel stays warning-only: nothing
		// bills a customer with no billable subscription.
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
		])
		stripe.deleteCustomer.mockRejectedValue(
			new Error('Stripe customer unavailable'),
		)
		stripe.cancelSubscription.mockClear()
		consoleError.mockImplementation(() => {})
		const { db: customerFailureDb, rows: customerFailureRows } =
			createStripeUserDb({
				id: 2,
				stableUserId: 'user-customer-failure',
				customerId: 'cus_failure',
			})

		const customerFailureResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(customerFailureDb),
			dbUserId: 2,
			mcpUserId: 'user-customer-failure',
		})

		expect(stripe.cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_active',
		)
		expect(stripe.deleteCustomer).toHaveBeenLastCalledWith(
			expect.any(Object),
			'cus_failure',
		)
		expect(customerFailureRows.users).toEqual([])
		expect(customerFailureResult.warnings).toEqual([
			expect.stringContaining('Stripe customer cleanup failed'),
		])
		expect(consoleError).toHaveBeenCalledOnce()
		expect(consoleError).toHaveBeenCalledWith(
			'account_deletion_stripe_cleanup_failed',
			expect.objectContaining({
				userId: 'user-customer-failure',
				error: expect.any(Error),
			}),
		)

		stripe.listSubscriptions.mockClear()
		stripe.deleteCustomer.mockClear()
		stripe.listCreditNotesForCustomer.mockClear()
		const { db: freeDb, rows: freeRows } = createStripeUserDb({
			id: 3,
			stableUserId: 'user-free',
			customerId: null,
		})
		await deleteUserAccount({
			env: createSuccessfulDeletionEnv(freeDb),
			dbUserId: 3,
			mcpUserId: 'user-free',
		})
		expect(stripe.listSubscriptions).not.toHaveBeenCalled()
		expect(stripe.listCreditNotesForCustomer).not.toHaveBeenCalled()
		expect(stripe.deleteCustomer).not.toHaveBeenCalled()
		expect(freeRows.users).toEqual([])
	} finally {
		stripe.restore()
		consoleError.mockReset()
	}
})

test('a failed Stripe cancellation retains the account, releases the fence, and touches nothing else', async () => {
	const stripe = spyOnStripeBillingClient()
	consoleError.mockImplementation(() => {})
	try {
		const cases: Array<{
			name: string
			stableUserId: string
			arrange: () => void
			expectedBillingErrors: Array<string>
		}> = [
			{
				name: 'listing fails',
				stableUserId: 'user-list-fails',
				arrange: () => {
					stripe.listSubscriptions.mockRejectedValue(
						new Error('Stripe subscriptions unavailable'),
					)
				},
				expectedBillingErrors: [
					'Stripe subscriptions could not be listed: Stripe subscriptions unavailable',
				],
			},
			{
				name: 'cancel is rejected and the subscription stays active',
				stableUserId: 'user-cancel-fails',
				arrange: () => {
					stripe.listSubscriptions.mockResolvedValue([
						stripeSubscription('sub_active', 'active'),
					])
					stripe.cancelSubscription.mockRejectedValue(
						new Error('Stripe cancel rejected'),
					)
				},
				expectedBillingErrors: [
					'Stripe subscription sub_active could not be canceled: Stripe cancel rejected',
				],
			},
		]
		for (const testCase of cases) {
			stripe.listSubscriptions.mockReset()
			stripe.cancelSubscription.mockReset()
			stripe.deleteCustomer.mockReset()
			stripe.deleteCustomer.mockResolvedValue(undefined)
			testCase.arrange()
			const deleteVectorsMock = vi.fn(async () => undefined)
			const { db, rows } = createStripeUserDb({
				id: 1,
				stableUserId: testCase.stableUserId,
				customerId: 'cus_billing',
			})
			const env = createSuccessfulDeletionEnv(db, {
				CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
			} as unknown as Partial<Env>)
			const meter = userMeterRpc({ env, userId: testCase.stableUserId })

			await expect(
				deleteUserAccount({
					env,
					dbUserId: 1,
					mcpUserId: testCase.stableUserId,
				}),
				testCase.name,
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof AccountDeletionBillingError &&
					JSON.stringify(error.billingErrors) ===
						JSON.stringify(testCase.expectedBillingErrors),
			)

			// Nothing destructive ran and the account is usable again.
			expect(deleteVectorsMock, testCase.name).not.toHaveBeenCalled()
			expect(stripe.deleteCustomer, testCase.name).not.toHaveBeenCalled()
			expect(rows.users, testCase.name).toEqual([
				expect.objectContaining({
					id: 1,
					stable_user_id: testCase.stableUserId,
					stripe_customer_id: 'cus_billing',
					deleting_at: null,
				}),
			])
			expect(rows.mcp_memories, testCase.name).toEqual([
				{ id: `mem-${testCase.stableUserId}`, user_id: testCase.stableUserId },
			])
			expect(await meter.readDeletionState(), testCase.name).toEqual({
				deletingAt: null,
			})
			expect(consoleError).toHaveBeenCalledWith(
				'account_deletion_billing_cancel_failed',
				{
					userId: testCase.stableUserId,
					billingErrors: testCase.expectedBillingErrors,
				},
			)
		}
	} finally {
		stripe.restore()
		consoleError.mockReset()
	}
})

test('a subscription that is already canceled counts as canceled so retried deletions proceed', async () => {
	const stripe = spyOnStripeBillingClient()
	try {
		// Retry after an earlier attempt already canceled everything: Stripe
		// lists the subscription as canceled, so nothing is canceled again.
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_old', 'canceled'),
		])
		const { db: retryDb, rows: retryRows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-retry',
			customerId: 'cus_retry',
		})
		const retryResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(retryDb),
			dbUserId: 1,
			mcpUserId: 'user-retry',
		})
		expect(stripe.cancelSubscription).not.toHaveBeenCalled()
		expect(retryRows.users).toEqual([])
		expect(retryResult.warnings).toEqual([])

		// The cancel call errors (for example Stripe raced the cancellation) but
		// a fresh listing shows the subscription is no longer billable.
		stripe.listSubscriptions
			.mockReset()
			.mockResolvedValueOnce([stripeSubscription('sub_racing', 'active')])
			.mockResolvedValueOnce([stripeSubscription('sub_racing', 'canceled')])
		stripe.cancelSubscription.mockRejectedValue(
			new Error('Stripe API request failed with HTTP 400.'),
		)
		const { db: raceDb, rows: raceRows } = createStripeUserDb({
			id: 2,
			stableUserId: 'user-race',
			customerId: 'cus_race',
		})
		const raceResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(raceDb),
			dbUserId: 2,
			mcpUserId: 'user-race',
		})
		expect(stripe.cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_racing',
		)
		expect(stripe.listSubscriptions).toHaveBeenCalledTimes(2)
		expect(raceRows.users).toEqual([])
		expect(raceResult.warnings).toEqual([])
		expect(stripe.deleteCustomer).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_race',
		)
	} finally {
		stripe.restore()
	}
})

test('account deletion refunds unused time with a credit note before canceling each paid subscription', async () => {
	const stripe = spyOnStripeBillingClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
			stripeSubscription('sub_trialing', 'trialing'),
			stripeSubscription('sub_past_due', 'past_due'),
		])
		stripe.listPaidInvoicesForSubscription.mockImplementation(
			async (_env, subscriptionId) => {
				if (subscriptionId === 'sub_active') {
					return [paidInvoice({ id: 'in_active', amountPaid: 1201 })]
				}
				// A trial that has not converted has a $0 paid invoice.
				return [paidInvoice({ id: 'in_trial', amountPaid: 0 })]
			},
		)
		stripe.createProratedRefundCreditNote.mockResolvedValue({
			id: 'cn_active',
			total: 600,
			currency: 'usd',
		})
		const { db, rows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-refund',
			customerId: 'cus_refund',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-refund',
		})

		// floor(1201 * 15d / 30d) = 600: the odd cent stays with Kody, never
		// rounds up against the invoice.
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
			expect.any(Object),
			{
				invoiceId: 'in_active',
				subscriptionId: 'sub_active',
				lines: [{ invoiceLineItemId: 'il_in_active', amount: 600 }],
				reason: 'order_change',
			},
		)
		expect(stripe.listCreditNotesForInvoice).toHaveBeenCalledWith(
			expect.any(Object),
			'in_active',
		)
		// Refund precedes the cancel of the same subscription so the invoice
		// line's service period is still intact when Stripe prorates tax.
		const creditNoteOrder =
			stripe.createProratedRefundCreditNote.mock.invocationCallOrder[0]!
		const activeCancelIndex = stripe.cancelSubscription.mock.calls.findIndex(
			([, subscriptionId]) => subscriptionId === 'sub_active',
		)
		expect(
			stripe.cancelSubscription.mock.invocationCallOrder[activeCancelIndex]!,
		).toBeGreaterThan(creditNoteOrder)
		expect(
			subscriptionIdsOf(stripe.listPaidInvoicesForSubscription.mock.calls),
		).toEqual(['sub_active', 'sub_trialing'])
		expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).toEqual([
			'sub_active',
			'sub_trialing',
			'sub_past_due',
		])
		expect(result.stripeRefunds).toEqual([
			{
				subscriptionId: 'sub_active',
				amountMinor: 600,
				currency: 'usd',
				invoiceId: 'in_active',
				creditNoteId: 'cn_active',
			},
		])
		expect(rows.users).toEqual([])
		expect(result.warnings).toEqual([])
		expect(logAuditEventSpy).toHaveBeenCalledWith({
			db: null,
			category: 'account',
			action: 'account_deletion_refund',
			result: 'success',
			email: 'user-refund@example.com',
			reason: 'usd:600',
		})
		expect(auditEventSummaries()).toEqual(['account_deletion_refund:success'])
	} finally {
		vi.useRealTimers()
		stripe.restore()
	}
})

test('discounts and tax are settled by the credit note preview, not by the gross line fraction', async () => {
	const stripe = spyOnStripeBillingClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_promo', 'active'),
		])
		// A 50% promotion code: the line's gross amount is $12.00 but the
		// customer paid $6.00. The invoice line's `amount` stays gross.
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([
			paidInvoice({
				id: 'in_promo',
				amountPaid: 600,
				lines: [
					{
						id: 'il_promo',
						amount: 1200,
						discount_amounts: [{ amount: 600 }],
					},
				],
			}),
		])
		// Stripe prorates the discount into the credit note: crediting half the
		// gross line ($6.00) nets $3.00 back to the customer.
		stripe.createProratedRefundCreditNote.mockResolvedValue({
			id: 'cn_promo',
			total: 300,
			currency: 'usd',
		})
		const { db } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-promo',
			customerId: 'cus_promo',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-promo',
		})

		// The credit note line is the gross fraction; the refund is the total
		// Stripe previewed after applying the line's discount share.
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				invoiceId: 'in_promo',
				lines: [{ invoiceLineItemId: 'il_promo', amount: 600 }],
			}),
		)
		expect(result.stripeRefunds).toEqual([
			expect.objectContaining({ amountMinor: 300, creditNoteId: 'cn_promo' }),
		])
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'account_deletion_refund',
				reason: 'usd:300',
			}),
		)
	} finally {
		vi.useRealTimers()
		stripe.restore()
	}
})

test('a $0 proration invoice on top does not hide the paid invoice that covers the period', async () => {
	const stripe = spyOnStripeBillingClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_downgraded', 'active'),
		])
		const changeAt = refundPeriodStart + thirtyDaysSeconds / 3
		// Newest first, as Stripe lists them: the downgrade netted to $0, then
		// an old invoice for a period that already ended, then the real payment.
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([
			paidInvoice({
				id: 'in_downgrade',
				amountPaid: 0,
				lines: [
					{
						id: 'il_new_plan',
						amount: 400,
						period: { start: changeAt, end: refundPeriodEnd },
					},
					{
						id: 'il_old_plan_credit',
						amount: -800,
						period: { start: changeAt, end: refundPeriodEnd },
					},
				],
			}),
			paidInvoice({
				id: 'in_previous_period',
				amountPaid: 1200,
				lines: [
					{
						id: 'il_previous',
						amount: 1200,
						period: {
							start: refundPeriodStart - thirtyDaysSeconds,
							end: refundPeriodStart,
						},
					},
				],
			}),
			paidInvoice({ id: 'in_current', amountPaid: 1200 }),
		])
		stripe.createProratedRefundCreditNote.mockResolvedValue({
			id: 'cn_current',
			total: 600,
			currency: 'usd',
		})
		const { db } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-downgraded',
			customerId: 'cus_downgraded',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-downgraded',
		})

		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				invoiceId: 'in_current',
				lines: [{ invoiceLineItemId: 'il_in_current', amount: 600 }],
			}),
		)
		expect(stripe.listCreditNotesForInvoice).toHaveBeenCalledWith(
			expect.any(Object),
			'in_current',
		)
		expect(result.stripeRefunds).toEqual([
			expect.objectContaining({
				invoiceId: 'in_current',
				creditNoteId: 'cn_current',
			}),
		])

		// With no paid invoice covering the running period at all, nothing is
		// refunded and the cancel still proceeds.
		stripe.createProratedRefundCreditNote.mockClear()
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([
			paidInvoice({
				id: 'in_only_previous',
				amountPaid: 1200,
				lines: [
					{
						id: 'il_only_previous',
						amount: 1200,
						period: {
							start: refundPeriodStart - thirtyDaysSeconds,
							end: refundPeriodStart,
						},
					},
				],
			}),
		])
		const { db: expiredDb, rows: expiredRows } = createStripeUserDb({
			id: 2,
			stableUserId: 'user-expired-period',
			customerId: 'cus_expired_period',
		})
		const expiredResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(expiredDb),
			dbUserId: 2,
			mcpUserId: 'user-expired-period',
		})
		expect(stripe.createProratedRefundCreditNote).not.toHaveBeenCalled()
		expect(expiredResult.stripeRefunds).toEqual([])
		expect(expiredRows.users).toEqual([])
	} finally {
		vi.useRealTimers()
		stripe.restore()
	}
})

test('every recurring line covering the period is credited on one credit note', async () => {
	const stripe = spyOnStripeBillingClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_multi', 'active'),
		])
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([
			paidInvoice({
				id: 'in_multi',
				amountPaid: 1500,
				lines: [
					{ id: 'il_plan', amount: 1000 },
					{ id: 'il_addon', amount: 501 },
					// A one-off line for a period that already ended has no unused
					// time and is left alone.
					{
						id: 'il_setup',
						amount: 2000,
						period: {
							start: refundPeriodStart - thirtyDaysSeconds,
							end: refundPeriodStart,
						},
					},
				],
			}),
		])
		stripe.createProratedRefundCreditNote.mockResolvedValue({
			id: 'cn_multi',
			total: 750,
			currency: 'usd',
		})
		const { db } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-multi',
			customerId: 'cus_multi',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-multi',
		})

		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
			expect.any(Object),
			{
				invoiceId: 'in_multi',
				subscriptionId: 'sub_multi',
				lines: [
					{ invoiceLineItemId: 'il_plan', amount: 500 },
					{ invoiceLineItemId: 'il_addon', amount: 250 },
				],
				reason: 'order_change',
			},
		)
		expect(result.stripeRefunds).toEqual([
			expect.objectContaining({ amountMinor: 750, creditNoteId: 'cn_multi' }),
		])
	} finally {
		vi.useRealTimers()
		stripe.restore()
	}
})

test('a failed credit note retains the account, releases the fence, and cancels nothing', async () => {
	const stripe = spyOnStripeBillingClient()
	consoleError.mockImplementation(() => {})
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
		])
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([
			paidInvoice({ id: 'in_active', amountPaid: 1200 }),
		])
		const cases: Array<{
			name: string
			stableUserId: string
			error: Error
			expectedMessage: string
		}> = [
			{
				name: 'network or 5xx failure',
				stableUserId: 'user-refund-fails',
				error: new Error('Stripe credit note rejected'),
				expectedMessage: 'Stripe credit note rejected',
			},
			{
				// The amount exceeding what Stripe will credit means Kody's math
				// disagrees with the invoice; that is never silently "nothing to
				// refund".
				name: 'amount exceeds the creditable remainder',
				stableUserId: 'user-refund-exceeds',
				error: new stripeClient.StripeApiError(
					'Stripe API request failed with HTTP 400.',
					{
						status: 400,
						stripeMessage:
							'The credit note amount exceeds the maximum creditable amount for this invoice.',
					},
				),
				expectedMessage: 'Stripe API request failed with HTTP 400.',
			},
		]
		for (const testCase of cases) {
			stripe.createProratedRefundCreditNote.mockRejectedValue(testCase.error)
			stripe.cancelSubscription.mockClear()
			stripe.deleteCustomer.mockClear()
			const deleteVectorsMock = vi.fn(async () => undefined)
			const { db, rows } = createStripeUserDb({
				id: 1,
				stableUserId: testCase.stableUserId,
				customerId: 'cus_refund_fails',
			})
			const env = createSuccessfulDeletionEnv(db, {
				CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
			} as unknown as Partial<Env>)
			const meter = userMeterRpc({ env, userId: testCase.stableUserId })
			const expectedBillingErrors = [
				`Stripe subscription sub_active unused time could not be refunded: ${testCase.expectedMessage}`,
			]

			await expect(
				deleteUserAccount({
					env,
					dbUserId: 1,
					mcpUserId: testCase.stableUserId,
				}),
				testCase.name,
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof AccountDeletionBillingError &&
					JSON.stringify(error.billingErrors) ===
						JSON.stringify(expectedBillingErrors),
			)

			// The subscription stays active so the retry can refund it, and
			// nothing destructive ran.
			expect(stripe.cancelSubscription, testCase.name).not.toHaveBeenCalled()
			expect(deleteVectorsMock, testCase.name).not.toHaveBeenCalled()
			expect(stripe.deleteCustomer, testCase.name).not.toHaveBeenCalled()
			expect(rows.users, testCase.name).toEqual([
				expect.objectContaining({
					id: 1,
					stable_user_id: testCase.stableUserId,
					stripe_customer_id: 'cus_refund_fails',
					deleting_at: null,
				}),
			])
			expect(rows.mcp_memories, testCase.name).toEqual([
				{ id: `mem-${testCase.stableUserId}`, user_id: testCase.stableUserId },
			])
			expect(await meter.readDeletionState(), testCase.name).toEqual({
				deletingAt: null,
			})
			expect(auditEventSummaries(), testCase.name).toEqual([])
			expect(consoleError).toHaveBeenCalledWith(
				'account_deletion_billing_cancel_failed',
				{
					userId: testCase.stableUserId,
					billingErrors: expectedBillingErrors,
				},
			)
		}
	} finally {
		vi.useRealTimers()
		stripe.restore()
		consoleError.mockReset()
	}
})

test('an invoice with nothing left to refund is canceled without a refund', async () => {
	const stripe = spyOnStripeBillingClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
		])
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([
			paidInvoice({ id: 'in_active', amountPaid: 1200 }),
		])
		const cases: Array<{
			name: string
			stableUserId: string
			arrange: () => void
		}> = [
			{
				// A 100% discounted line previews to a $0 credit note; the client
				// reports that instead of creating an empty note.
				name: 'credit note previews to zero',
				stableUserId: 'user-refund-zero',
				arrange: () => {
					stripe.createProratedRefundCreditNote.mockResolvedValue(null)
				},
			},
			{
				// Support already refunded the charge by hand, outside a credit
				// note, so Stripe refuses a second refund.
				name: 'charge already refunded (coded)',
				stableUserId: 'user-refund-coded',
				arrange: () => {
					stripe.createProratedRefundCreditNote.mockRejectedValue(
						new stripeClient.StripeApiError(
							'Stripe API request failed with HTTP 400.',
							{ status: 400, code: 'charge_already_refunded' },
						),
					)
				},
			},
			{
				name: 'charge already refunded (message only)',
				stableUserId: 'user-refund-message',
				arrange: () => {
					stripe.createProratedRefundCreditNote.mockRejectedValue(
						new stripeClient.StripeApiError(
							'Stripe API request failed with HTTP 400.',
							{
								status: 400,
								stripeMessage:
									'The charge for this invoice has already been fully refunded.',
							},
						),
					)
				},
			},
		]
		for (const testCase of cases) {
			stripe.createProratedRefundCreditNote.mockReset()
			stripe.cancelSubscription.mockClear()
			testCase.arrange()
			const { db, rows } = createStripeUserDb({
				id: 1,
				stableUserId: testCase.stableUserId,
				customerId: 'cus_nothing_left',
			})

			const result = await deleteUserAccount({
				env: createSuccessfulDeletionEnv(db),
				dbUserId: 1,
				mcpUserId: testCase.stableUserId,
			})

			expect(
				stripe.createProratedRefundCreditNote,
				testCase.name,
			).toHaveBeenCalledOnce()
			expect(stripe.cancelSubscription, testCase.name).toHaveBeenCalledWith(
				expect.any(Object),
				'sub_active',
			)
			expect(result.stripeRefunds, testCase.name).toEqual([])
			expect(result.warnings, testCase.name).toEqual([])
			expect(rows.users, testCase.name).toEqual([])
			const audited = auditEventSummaries()
			expect(audited, testCase.name).toEqual([])
		}
	} finally {
		vi.useRealTimers()
		stripe.restore()
	}
})

test('a retried deletion reuses its earlier credit note and reports refunds from earlier attempts', async () => {
	const stripe = spyOnStripeBillingClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date(refundPeriodMidpointMs))

		// Retry: the first attempt refunded and canceled sub_done, refunded
		// sub_retry but failed before canceling it, and never reached sub_new.
		stripe.listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_done', 'canceled'),
			stripeSubscription('sub_retry', 'active'),
			stripeSubscription('sub_new', 'active'),
		])
		stripe.listPaidInvoicesForSubscription.mockImplementation(
			async (_env, subscriptionId) => [
				paidInvoice({ id: `in_${subscriptionId}`, amountPaid: 1200 }),
			],
		)
		stripe.listCreditNotesForInvoice.mockImplementation(
			async (_env, invoiceId) =>
				invoiceId === 'in_sub_retry'
					? [
							// Voided notes and notes without the metadata marker (even
							// with Kody's memo text) are never treated as ours.
							kodyCreditNote({
								id: 'cn_voided',
								invoice: 'in_sub_retry',
								total: 600,
								status: 'void',
								subscriptionId: 'sub_retry',
							}),
							{
								id: 'cn_support',
								invoice: 'in_sub_retry',
								total: 100,
								currency: 'usd',
								status: 'issued',
								metadata: { memo: stripeClient.accountDeletionCreditNoteMemo },
							},
							kodyCreditNote({
								id: 'cn_retry_earlier',
								invoice: 'in_sub_retry',
								total: 600,
								subscriptionId: 'sub_retry',
							}),
						]
					: [],
		)
		stripe.createProratedRefundCreditNote.mockResolvedValue({
			id: 'cn_new',
			total: 600,
			currency: 'usd',
		})
		stripe.listCreditNotesForCustomer.mockResolvedValue([
			kodyCreditNote({
				id: 'cn_new',
				invoice: 'in_sub_new',
				total: 600,
				subscriptionId: 'sub_new',
			}),
			kodyCreditNote({
				id: 'cn_retry_earlier',
				invoice: 'in_sub_retry',
				total: 600,
				subscriptionId: 'sub_retry',
			}),
			kodyCreditNote({
				id: 'cn_done_earlier',
				invoice: 'in_sub_done',
				total: 450,
				subscriptionId: 'sub_done',
			}),
			kodyCreditNote({
				id: 'cn_done_voided',
				invoice: 'in_sub_done',
				total: 450,
				status: 'void',
			}),
			kodyCreditNote({
				id: 'cn_manual',
				invoice: 'in_sub_done',
				total: 100,
				marker: false,
			}),
		])
		const { db, rows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-refund-retry',
			customerId: 'cus_refund_retry',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-refund-retry',
		})

		// Only sub_new gets a new credit note; sub_retry reuses its earlier one.
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ invoiceId: 'in_sub_new' }),
		)
		expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).toEqual([
			'sub_retry',
			'sub_new',
		])
		expect(stripe.listCreditNotesForCustomer).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_refund_retry',
		)
		expect(result.stripeRefunds).toEqual([
			{
				subscriptionId: 'sub_retry',
				amountMinor: 600,
				currency: 'usd',
				invoiceId: 'in_sub_retry',
				creditNoteId: 'cn_retry_earlier',
			},
			{
				subscriptionId: 'sub_new',
				amountMinor: 600,
				currency: 'usd',
				invoiceId: 'in_sub_new',
				creditNoteId: 'cn_new',
			},
			{
				subscriptionId: 'sub_done',
				amountMinor: 450,
				currency: 'usd',
				invoiceId: 'in_sub_done',
				creditNoteId: 'cn_done_earlier',
			},
		])
		expect(rows.users).toEqual([])
		// Only the newly issued refund is audited; earlier attempts already did.
		expect(auditEventSummaries()).toEqual(['account_deletion_refund:success'])
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'usd:600' }),
		)

		// The customer-wide listing only completes the report; when it fails the
		// deletion still finishes with what this run knows.
		stripe.listCreditNotesForCustomer.mockRejectedValue(
			new Error('Stripe credit notes unavailable'),
		)
		consoleWarn.mockImplementation(() => {})
		const { db: partialDb, rows: partialRows } = createStripeUserDb({
			id: 2,
			stableUserId: 'user-refund-partial-report',
			customerId: 'cus_refund_partial_report',
		})
		const partialResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(partialDb),
			dbUserId: 2,
			mcpUserId: 'user-refund-partial-report',
		})
		expect(partialRows.users).toEqual([])
		expect(partialResult.warnings).toEqual([])
		expect(
			partialResult.stripeRefunds.map((refund) => refund.creditNoteId),
		).toEqual(['cn_retry_earlier', 'cn_new'])
		expect(consoleWarn).toHaveBeenCalledWith(
			'account_deletion_refund_report_incomplete',
			{ error: 'Stripe credit notes unavailable' },
		)
	} finally {
		vi.useRealTimers()
		stripe.restore()
		consoleWarn.mockReset()
	}
})
