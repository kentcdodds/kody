import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountBillingData } from '#app/account-billing-data.ts'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import {
	createBillingPortalSession,
	BillingNotConfiguredError,
} from '#worker/billing/stripe-client.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSession,
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
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
			}

			const errorCode = new URL(request.url).searchParams.get('error')
			const accountBilling = await loadAccountBillingData({
				env,
				userId: user.userId,
				email: user.email,
				stableUserId: user.mcpUser.userId,
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
				email: user.email,
				stableUserId: user.mcpUser.userId,
				errorCode,
			})
			return jsonResponse(accountBilling)
		},
	} satisfies Action<typeof routes.accountBillingApi>
}

export function createAccountBillingSuccessHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
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
				await linkStripeCustomerFromCheckoutSession({
					env,
					user: {
						id: user.userId,
						email: user.email,
						stableUserId: user.mcpUser.userId,
					},
					sessionId,
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
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
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
