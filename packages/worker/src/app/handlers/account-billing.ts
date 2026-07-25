import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountBillingData } from '#app/account-billing-data.ts'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import {
	createBillingPortalSession,
	createCheckoutSession,
	BillingNotConfiguredError,
	StripeApiError,
} from '#worker/billing/stripe-client.ts'
import {
	createBillingLinkReference,
	getProPriceId,
	isBillingConfigured,
} from '#worker/billing/billing-config.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSessionAttribution,
} from '#worker/billing/subscription-sync.ts'

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

			const errorCode = new URL(request.url).searchParams.get('error')
			const accountBilling = await loadAccountBillingData({
				env,
				userId: user.userId,
				errorCode,
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

			const errorCode = new URL(request.url).searchParams.get('error')
			const accountBilling = await loadAccountBillingData({
				env,
				userId: user.userId,
				errorCode,
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

			const priceId = getProPriceId(env)
			if (!isBillingConfigured(env) || !priceId) {
				return jsonResponse(
					{
						ok: false,
						error: 'Billing is not configured on this deployment.',
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
			const clientReferenceId = await createBillingLinkReference(
				env,
				user.mcpUser.userId,
			)
			const successUrl = `${new URL('/account/billing/success', request.url).toString()}?session_id={CHECKOUT_SESSION_ID}`
			const cancelUrl = new URL('/account/billing', request.url).toString()
			const requestIp = getRequestIp(request) ?? undefined

			try {
				const session = await createCheckoutSession(env, {
					priceId,
					clientReferenceId,
					successUrl,
					cancelUrl,
					...(customerId ? { customerId } : { customerEmail: user.email }),
					// Lets the Stripe webhook resolve the user without reversing
					// the HMAC client_reference_id (still verified on link).
					metadata: { kody_stable_user_id: user.mcpUser.userId },
				})
				void logAuditEvent({
					category: 'account',
					action: 'billing_checkout_started',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: new URL(request.url).pathname,
				})
				return jsonResponse({ ok: true, url: session.url })
			} catch (error) {
				if (error instanceof StripeApiError) {
					console.error('billing_checkout_failed', {
						userId: user.userId,
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
					category: 'account',
					action: 'billing_checkout_linked',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: new URL(request.url).pathname,
				})
				return Response.redirect(new URL('/account/billing', request.url), 302)
			} catch (error) {
				const code =
					error instanceof BillingLinkError ? error.code : 'link_failed'
				void logAuditEvent({
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
					userId: user.userId,
					error: error instanceof Error ? error.message : String(error),
				})
				return billingErrorRedirect(request, 'portal_failed')
			}
		},
	} satisfies Action<typeof routes.accountBillingPortal>
}
