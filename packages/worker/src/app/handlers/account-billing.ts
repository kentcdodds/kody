import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountBillingData } from '#app/account-billing-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { userHasMcpOAuthGrants } from '#app/onboarding-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	createBillingPortalSession,
	createCheckoutSession,
	listSubscriptions,
	BillingNotConfiguredError,
	StripeApiError,
} from '#worker/billing/stripe-client.ts'
import {
	createBillingLinkReference,
	getBillingPortalConfigurationId,
	getPriceIdForPlan,
	isBillingConfigured,
	parseBillingInterval,
	selectPlanRetainingSubscriptions,
	subscriptionHasPrice,
} from '#worker/billing/billing-config.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSessionAttribution,
} from '#worker/billing/subscription-sync.ts'
import { enqueuePlatformFeedbackDispatch } from '#worker/platform-feedback/dispatch-queue-producer.ts'
import { isPlatformFeedbackDomainError } from '#worker/platform-feedback/errors.ts'
import { submitPlatformFeedback } from '#worker/platform-feedback/service.ts'

function billingErrorRedirect(request: Request, errorCode: string) {
	const url = new URL('/account/billing', request.url)
	url.searchParams.set('error', errorCode)
	return Response.redirect(url.toString(), 302)
}

export function createAccountBillingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const searchParams = new URL(request.url).searchParams
			const accountBilling = await loadAccountBillingData({
				env,
				userId: user.userId,
				errorCode: searchParams.get('error'),
				noticeCode: searchParams.get('billing'),
			})
			return renderAppPage({
				request,
				env,
				title: 'Billing',
				loaderData: { accountBilling },
			})
		},
	} satisfies Action<typeof routes.accountBilling>
}

export function createAccountBillingApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const searchParams = new URL(request.url).searchParams
			const accountBilling = await loadAccountBillingData({
				env,
				userId: user.userId,
				errorCode: searchParams.get('error'),
				noticeCode: searchParams.get('billing'),
			})
			return jsonResponse(accountBilling)
		},
	} satisfies Action<typeof routes.accountBillingApi>
}

export function createAccountBillingCheckoutApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = (await request.json().catch(() => null)) as {
				plan?: unknown
				interval?: unknown
			} | null
			const plan =
				body?.plan === 'standard' || body?.plan === 'pro' ? body.plan : null
			if (!plan) {
				return jsonResponse(
					{ ok: false, error: 'Choose Standard or Pro.' },
					400,
				)
			}
			const interval = parseBillingInterval(body?.interval)
			if (!interval) {
				return jsonResponse(
					{ ok: false, error: 'Choose monthly or annual billing.' },
					400,
				)
			}
			const priceId = getPriceIdForPlan(env, plan, interval)
			if (!isBillingConfigured(env) || !priceId) {
				return jsonResponse(
					{
						ok: false,
						error: `${plan === 'standard' ? 'Standard' : 'Pro'} checkout is not configured on this deployment.`,
					},
					409,
				)
			}

			const row = await env.APP_DB.prepare(
				`SELECT stripe_customer_id FROM users WHERE id = ?`,
			)
				.bind(user.userId)
				.first<{ stripe_customer_id: string | null }>()
			const customerId = row?.stripe_customer_id?.trim() || undefined
			const billingUrl = new URL('/account/billing', request.url).toString()
			const requestIp = getRequestIp(request) ?? undefined
			const requestPath = new URL(request.url).pathname

			try {
				if (customerId) {
					// An existing subscriber must change plans on their current
					// subscription. A second Checkout Session would create a second
					// subscription that bills alongside the first (the plan resolver
					// grants the higher tier across all of them), so route plan
					// switches through the portal's prorated update flow instead.
					const planRetaining = selectPlanRetainingSubscriptions(
						await listSubscriptions(env, customerId),
					)
					if (planRetaining.length === 1) {
						const subscription = planRetaining[0]!
						if (subscriptionHasPrice(subscription, priceId)) {
							return jsonResponse(
								{ ok: false, error: 'You are already on that plan.' },
								409,
							)
						}
						const updatedUrl = new URL(billingUrl)
						updatedUrl.searchParams.set('billing', 'updated')
						const portal = await createBillingPortalSession(env, {
							customerId,
							returnUrl: billingUrl,
							configuration: getBillingPortalConfigurationId(env),
							flowData: {
								type: 'subscription_update',
								subscriptionId: subscription.id,
								afterCompletionRedirectUrl: updatedUrl.toString(),
							},
						})
						void logAuditEvent({
							db: auditDatabaseFromEnv(env),
							category: 'account',
							action: 'billing_plan_change_started',
							result: 'success',
							email: user.email,
							ip: requestIp,
							path: requestPath,
						})
						return jsonResponse({
							ok: true,
							url: portal.url,
							mode: 'portal_update',
						})
					}
					if (planRetaining.length > 1) {
						// Legacy double subscriptions: the portal update flow targets
						// one subscription, so let the customer sort out which to keep.
						const portal = await createBillingPortalSession(env, {
							customerId,
							returnUrl: billingUrl,
							configuration: getBillingPortalConfigurationId(env),
						})
						return jsonResponse({
							ok: true,
							url: portal.url,
							mode: 'portal',
						})
					}
				}

				const clientReferenceId = await createBillingLinkReference(
					env,
					user.mcpUser.userId,
				)
				const successUrl = `${new URL('/account/billing/success', request.url).toString()}?session_id={CHECKOUT_SESSION_ID}`
				const session = await createCheckoutSession(env, {
					priceId,
					clientReferenceId,
					successUrl,
					cancelUrl: billingUrl,
					...(customerId ? { customerId } : { customerEmail: user.email }),
					// Lets the Stripe webhook resolve the user without reversing
					// the HMAC client_reference_id (still verified on link).
					metadata: { kody_stable_user_id: user.mcpUser.userId },
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_checkout_started',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: requestPath,
				})
				return jsonResponse({ ok: true, url: session.url, mode: 'checkout' })
			} catch (error) {
				if (error instanceof StripeApiError) {
					console.error('billing_checkout_failed', {
						stableUserId: user.mcpUser.userId,
						error: error.message,
					})
					return jsonResponse(
						{
							ok: false,
							error: 'Unable to start checkout. Try again shortly.',
						},
						502,
					)
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.accountBillingCheckoutPost>
}

export function createAccountBillingCancellationFeedbackApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = (await request.json().catch(() => null)) as {
				details?: unknown
			} | null
			const details =
				typeof body?.details === 'string' ? body.details.trim() : ''
			if (!details) {
				return jsonResponse(
					{ ok: false, error: 'Share a sentence or two before sending.' },
					400,
				)
			}
			if (details.length > 8000) {
				return jsonResponse(
					{ ok: false, error: 'Feedback is limited to 8000 characters.' },
					400,
				)
			}

			const submitterUsername = user.username.trim()
			if (!submitterUsername) {
				return jsonResponse(
					{ ok: false, error: 'Unable to submit feedback for this account.' },
					409,
				)
			}

			try {
				const feedback = await submitPlatformFeedback({
					db: env.APP_DB,
					submitterUserId: user.mcpUser.userId,
					submitterUsername,
					submitterEmail: user.email,
					category: 'cancellation',
					summary: 'Subscription cancellation feedback',
					details,
				})
				try {
					await enqueuePlatformFeedbackDispatch({
						queue: env.PLATFORM_FEEDBACK_DISPATCH_QUEUE,
						feedbackId: feedback.id,
					})
				} catch (error) {
					console.error('platform-feedback-dispatch-enqueue-failed', error)
				}
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_cancellation_feedback',
					result: 'success',
					email: user.email,
					ip: getRequestIp(request) ?? undefined,
					path: new URL(request.url).pathname,
				})
				return jsonResponse({ ok: true })
			} catch (error) {
				if (isPlatformFeedbackDomainError(error)) {
					return jsonResponse({ ok: false, error: error.message }, 429)
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.accountBillingCancellationFeedbackPost>
}

export function createAccountBillingSuccessHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			if (!isBillingConfigured(env)) {
				return billingErrorRedirect(request, 'billing_not_configured')
			}

			const sessionId =
				new URL(request.url).searchParams.get('session_id')?.trim() ?? ''
			if (!sessionId) {
				return billingErrorRedirect(request, 'missing_session')
			}

			const requestIp = getRequestIp(request) ?? undefined
			try {
				await linkStripeCustomerFromCheckoutSessionAttribution({
					env,
					sessionId,
					user: {
						id: user.userId,
						email: user.email,
						stableUserId: user.mcpUser.userId,
					},
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_checkout_linked',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: new URL(request.url).pathname,
				})
				const hasMcpClient = await userHasMcpOAuthGrants(
					env,
					user.mcpUser.userId,
				)
				const needsOnboarding = !user.emailVerified || !hasMcpClient
				return renderAppPage({
					request,
					env,
					title: "You're in",
					loaderData: {
						accountBillingSuccess: {
							ok: true,
							needsOnboarding,
						},
					},
				})
			} catch (error) {
				const code =
					error instanceof BillingLinkError ? error.code : 'link_failed'
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_checkout_linked',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: new URL(request.url).pathname,
					reason: code,
				})
				return billingErrorRedirect(request, code)
			}
		},
	} satisfies Action<typeof routes.accountBillingSuccess>
}

export function createAccountBillingPortalHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			if (!isBillingConfigured(env)) {
				return billingErrorRedirect(request, 'billing_not_configured')
			}

			const row = await env.APP_DB.prepare(
				`SELECT stripe_customer_id FROM users WHERE id = ?`,
			)
				.bind(user.userId)
				.first<{ stripe_customer_id: string | null }>()
			const customerId = row?.stripe_customer_id?.trim()
			if (!customerId) {
				return billingErrorRedirect(request, 'no_customer')
			}

			const returnUrl = new URL('/account/billing', request.url).toString()
			try {
				const portal = await createBillingPortalSession(env, {
					customerId,
					returnUrl,
					configuration: getBillingPortalConfigurationId(env),
				})
				// Trust assumption: portal.url comes from the Stripe API host,
				// which is operator-controlled deployment config
				// (STRIPE_API_BASE_URL, default api.stripe.com) — not
				// user-influenced — so redirecting to it is not an open
				// redirect.
				return Response.redirect(portal.url, 302)
			} catch (error) {
				if (error instanceof BillingNotConfiguredError) {
					return billingErrorRedirect(request, 'billing_not_configured')
				}
				console.error('billing_portal_failed', {
					stableUserId: user.mcpUser.userId,
					error: error instanceof Error ? error.message : String(error),
				})
				return billingErrorRedirect(request, 'portal_failed')
			}
		},
	} satisfies Action<typeof routes.accountBillingPortal>
}
