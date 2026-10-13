import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { loadAccountCreditsUser } from '#app/account-credits-data.ts'
import { loadAccountUsageData } from '#app/account-usage-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { personalOrgUsageRedirectUrl } from '#app/handlers/org-usage.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { orgUsageCreditsPath } from '#universal/org-pages.ts'
import {
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
	type CreditNotifySettings,
} from '#universal/credits.ts'
import { type routes } from '#universal/routes.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import { startCreditTopUpCheckout } from '#worker/billing/credit-top-ups.ts'
import {
	ensureCreditWallet,
	updateCreditWalletSettings,
} from '#worker/billing/credit-wallet.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { type BillingPageOrg } from '#app/account-billing-data.ts'

/**
 * Where an old `/account/credits` link lands once the personal org slug is
 * known. Kept for unit tests that build the URL without auth.
 */
export function accountCreditsRedirectUrl(
	requestUrl: string,
	slug: string,
): string {
	return personalOrgUsageRedirectUrl({
		requestUrl,
		slug,
		credits: true,
	})
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

async function personalOrgSlug(env: Env, user: AuthenticatedAppUser) {
	const signupOrg = await getOrgById(
		env.APP_DB,
		personalOrgId(user.mcpUser.userId),
	)
	return signupOrg?.slug?.trim() || user.username
}

/**
 * Organization a credits mutation acts on. Path/Referer bind via
 * {@link loadRequestOrgResolution}; missing org falls back to the signup
 * organization. Requires `billing:write`.
 */
async function resolveCreditsOrg(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
}): Promise<
	| { ok: true; org: BillingPageOrg }
	| { ok: false; status: 403 | 404; error: string }
> {
	const resolution = await loadRequestOrgResolution(
		input.request,
		input.env,
		input.user.mcpUser.userId,
	)
	if (resolution === 'denied') {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			'billing:write',
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		const slug =
			resolution === 'personal'
				? input.user.username
				: (resolution.org.slug ?? input.user.username)
		return {
			ok: false,
			status: 403,
			error: `Only owners and billing admins can manage credits for @${slug}.`,
		}
	}
	if (resolution === 'personal') {
		const id = personalOrgId(input.user.mcpUser.userId)
		const record = await getOrgById(input.env.APP_DB, id)
		return {
			ok: true,
			org: {
				id,
				slug: record?.slug?.trim() || input.user.username,
				displayName: record?.display_name ?? null,
				personal: true,
			},
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		throw new Error(`Cannot load credits: missing org ${resolution.org.id}.`)
	}
	return {
		ok: true,
		org: {
			id: resolution.org.id,
			slug: record.slug,
			displayName: record.display_name,
			personal: resolution.org.id === personalOrgId(input.user.mcpUser.userId),
		},
	}
}

export function createAccountCreditsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const slug = await personalOrgSlug(env, user)
			return Response.redirect(
				accountCreditsRedirectUrl(request.url, slug),
				302,
			)
		},
	} satisfies Action<typeof routes.accountCredits>
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
			const access = await resolveCreditsOrg({ request, env, user })
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
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
				orgId: access.org.id,
				personal: access.org.personal,
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
					creditsUrl: new URL(
						orgUsageCreditsPath(access.org.slug),
						request.url,
					).toString(),
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
			const access = await resolveCreditsOrg({ request, env, user })
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
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
				orgId: access.org.id,
				personal: access.org.personal,
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
			const accountUsage = await loadAccountUsageData({
				env,
				userId: user.userId,
				org: access.org,
				notice: 'Credit settings saved.',
				now,
			})
			return jsonResponse(accountUsage ?? { ok: false, error: 'Not found.' })
		},
	} satisfies Action<typeof routes.accountCreditsSettingsPost>
}
