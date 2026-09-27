import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	loadAccountCreditsData,
	loadAccountCreditsUser,
} from '#app/account-credits-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
	type CreditNotifySettings,
} from '#universal/credits.ts'
import { type routes } from '#universal/routes.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import {
	applyCreditTopUpFromCheckoutSession,
	CreditTopUpError,
	startCreditTopUpCheckout,
} from '#worker/billing/credit-top-ups.ts'
import {
	ensureCreditWallet,
	updateCreditWalletSettings,
} from '#worker/billing/credit-wallet.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'

const creditsNoticeMessages: Record<string, string> = {
	added: 'Credits added. Higher limits apply within a minute.',
}

const creditsErrorMessages: Record<string, string> = {
	topup_failed: 'We could not confirm that top-up. Refresh in a moment.',
	not_paid: 'That top-up has not been paid yet.',
	client_reference_mismatch: 'That top-up does not belong to your account.',
}

function creditsRedirect(request: Request, params: Record<string, string>) {
	const url = new URL('/account/credits', request.url)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return Response.redirect(url.toString(), 302)
}

function readNotifySettings(value: unknown): CreditNotifySettings | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const autoRefilled = record['autoRefilled']
	const monthlyCap = record['monthlyCap']
	const lowBalance = record['lowBalance']
	if (
		typeof autoRefilled !== 'boolean' ||
		typeof monthlyCap !== 'boolean' ||
		typeof lowBalance !== 'boolean'
	) {
		return null
	}
	return { autoRefilled, monthlyCap, lowBalance }
}

export function createAccountCreditsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user

			const searchParams = new URL(request.url).searchParams
			const sessionId = searchParams.get('session_id')?.trim()
			if (searchParams.get('topup') === 'success' && sessionId) {
				try {
					await applyCreditTopUpFromCheckoutSession({
						env,
						sessionId,
						expectedStableUserId: user.mcpUser.userId,
						now: new Date(),
					})
					return creditsRedirect(request, { credits: 'added' })
				} catch (error) {
					const code =
						error instanceof CreditTopUpError ? error.code : 'topup_failed'
					console.error('credit_top_up_confirm_failed', { code })
					return creditsRedirect(request, {
						error: code in creditsErrorMessages ? code : 'topup_failed',
					})
				}
			}

			const noticeCode = searchParams.get('credits') ?? ''
			const errorCode = searchParams.get('error') ?? ''
			const accountCredits = await loadAccountCreditsData({
				env,
				userId: user.userId,
				notice: creditsNoticeMessages[noticeCode],
				error: creditsErrorMessages[errorCode],
			})
			if (!accountCredits) return new Response('Not found', { status: 404 })
			return renderAppPage({
				request,
				env,
				title: 'Credits',
				loaderData: { accountCredits },
			})
		},
	} satisfies Action<typeof routes.accountCredits>
}

export function createAccountCreditsApiHandler(env: Env) {
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
			const accountCredits = await loadAccountCreditsData({
				env,
				userId: user.userId,
			})
			if (!accountCredits) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			return jsonResponse(accountCredits)
		},
	} satisfies Action<typeof routes.accountCreditsApi>
}

export function createAccountCreditsTopUpApiHandler(env: Env) {
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
				amountCents?: unknown
			} | null
			const amount = validateCreditTopUpCents(body?.amountCents)
			if (!amount.ok) {
				return jsonResponse({ ok: false, error: amount.error }, 400)
			}
			if (!isBillingConfigured(env)) {
				return jsonResponse(
					{ ok: false, error: 'Billing is not configured on this deployment.' },
					409,
				)
			}
			const now = new Date()
			const creditsUser = await loadAccountCreditsUser({
				env,
				userId: user.userId,
				now,
			})
			if (!creditsUser?.canBuyCredits || !creditsUser.stripeCustomerId) {
				return jsonResponse(
					{ ok: false, error: 'Subscribe to Pro to add credits.' },
					409,
				)
			}
			await ensureCreditWallet({
				db: env.APP_DB,
				userId: creditsUser.stableUserId,
				entitlement: creditsUser.entitlement,
				now,
			})
			try {
				const checkout = await startCreditTopUpCheckout({
					env,
					stableUserId: creditsUser.stableUserId,
					stripeCustomerId: creditsUser.stripeCustomerId,
					amountCents: amount.cents,
					creditsUrl: new URL('/account/credits', request.url).toString(),
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'credits_top_up_started',
					result: 'success',
					email: user.email,
					ip: getRequestIp(request) ?? undefined,
					path: new URL(request.url).pathname,
					reason: `amount_cents=${amount.cents}`,
				})
				return jsonResponse({ ok: true, url: checkout.url })
			} catch (error) {
				if (error instanceof StripeApiError) {
					console.error('credit_top_up_checkout_failed', {
						status: error.status,
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
	} satisfies Action<typeof routes.accountCreditsTopUpPost>
}

export function createAccountCreditsSettingsApiHandler(env: Env) {
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
				autoRefill?: unknown
				notify?: unknown
			} | null
			const autoRefill = validateCreditAutoRefillSettings(body?.autoRefill)
			if (!autoRefill.ok) {
				return jsonResponse({ ok: false, error: autoRefill.error }, 400)
			}
			const notify = readNotifySettings(body?.notify)
			if (!notify) {
				return jsonResponse(
					{ ok: false, error: 'Notification settings are required.' },
					400,
				)
			}
			const now = new Date()
			const creditsUser = await loadAccountCreditsUser({
				env,
				userId: user.userId,
				now,
			})
			if (!creditsUser?.canBuyCredits) {
				return jsonResponse(
					{ ok: false, error: 'Subscribe to Pro to change credit settings.' },
					409,
				)
			}
			await ensureCreditWallet({
				db: env.APP_DB,
				userId: creditsUser.stableUserId,
				entitlement: creditsUser.entitlement,
				now,
			})
			await updateCreditWalletSettings({
				db: env.APP_DB,
				userId: creditsUser.stableUserId,
				autoRefill: autoRefill.value,
				notify,
				now,
			})
			const accountCredits = await loadAccountCreditsData({
				env,
				userId: user.userId,
				notice: 'Credit settings saved.',
				now,
			})
			return jsonResponse(accountCredits ?? { ok: false, error: 'Not found.' })
		},
	} satisfies Action<typeof routes.accountCreditsSettingsPost>
}
