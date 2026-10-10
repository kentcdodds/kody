/**
 * soft-delete-read-filter: opt-out
 *
 * Soft-delete stamps `deleted_at` before canceling Stripe. Customer id lookup
 * must still see the tombstoned org/user row.
 *
 * Cancel Kody Stripe subscriptions when an account/org is soft-deleted so the
 * restore window does not keep charging. Hard purge still runs the fuller
 * account-deletion billing path (refunds + customer delete).
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isKodySubscription } from './billing-config.ts'
import {
	cancelSubscription,
	listSubscriptions,
	type StripeSubscription,
} from './stripe-client.ts'

const billableStatuses = new Set([
	'active',
	'trialing',
	'past_due',
	'unpaid',
	'paused',
	'incomplete',
])

function isBillableSubscription(subscription: StripeSubscription) {
	return billableStatuses.has(subscription.status)
}

/** Org Stripe customer, including a soft-deleted org row. */
async function readStripeCustomerIdIncludingSoftDeleted(
	db: D1Database,
	ownerId: string,
): Promise<string | null> {
	const org = await db
		.prepare(`SELECT stripe_customer_id FROM orgs WHERE id = ?`)
		.bind(ownerId)
		.first<{ stripe_customer_id: string | null }>()
	return org?.stripe_customer_id?.trim() || null
}

export async function cancelKodySubscriptionsForSoftDelete(input: {
	env: Env
	/** Org id or personal stable user id that owns the Stripe customer. */
	ownerId: string
}): Promise<{ canceled: number; customerId: string | null }> {
	const customerId = await readStripeCustomerIdIncludingSoftDeleted(
		input.env.APP_DB,
		input.ownerId,
	)
	if (!customerId) {
		return { canceled: 0, customerId: null }
	}
	let subscriptions: Awaited<ReturnType<typeof listSubscriptions>>
	try {
		subscriptions = await listSubscriptions(input.env, customerId)
	} catch (error) {
		console.warn('soft-delete-stripe-list-failed', {
			ownerId: input.ownerId,
			error: getErrorMessage(error),
		})
		return { canceled: 0, customerId }
	}
	const billable = subscriptions.filter(
		(subscription) =>
			isBillableSubscription(subscription) &&
			isKodySubscription(input.env, subscription),
	)
	let canceled = 0
	for (const subscription of billable) {
		try {
			await cancelSubscription(input.env, subscription.id)
			canceled += 1
		} catch (error) {
			console.warn('soft-delete-stripe-cancel-failed', {
				ownerId: input.ownerId,
				subscriptionId: subscription.id,
				error: getErrorMessage(error),
			})
		}
	}
	return { canceled, customerId }
}
