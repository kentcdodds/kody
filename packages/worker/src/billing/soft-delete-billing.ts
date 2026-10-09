/**
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
import { readOrgStripeCustomerId } from '#worker/orgs/billing.ts'

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

export async function cancelKodySubscriptionsForSoftDelete(input: {
	env: Env
	/** Org id or personal stable user id that owns the Stripe customer. */
	ownerId: string
}): Promise<{ canceled: number; customerId: string | null }> {
	const customerId = await readOrgStripeCustomerId(
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
