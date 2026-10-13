import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type BillingPageOrg } from '#app/account-billing-data.ts'
import { loadAccountUsageData } from '#app/account-usage-data.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { orgUsageCreditsPath, orgUsagePath } from '#universal/org-pages.ts'
import { type routes } from '#universal/routes.ts'
import {
	applyCreditTopUpFromCheckoutSession,
	CreditTopUpError,
} from '#worker/billing/credit-top-ups.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

type OrgUsageAccess =
	| { ok: true; org: BillingPageOrg }
	| { ok: false; status: 403 | 404; error: string }

const creditsNoticeMessages: Record<string, string> = {
	added:
		'Credits added. Usage past your monthly include runs on them within a minute.',
}

const creditsErrorMessages: Record<string, string> = {
	topup_failed: 'We could not confirm that top-up. Refresh in a moment.',
	not_paid: 'That top-up has not been paid yet.',
	client_reference_mismatch: 'That top-up does not belong to your account.',
}

function readMessage(
	messages: Record<string, string>,
	code: string | null,
): string | undefined {
	return code && Object.hasOwn(messages, code) ? messages[code] : undefined
}

/**
 * The organization a `/@slug/-/usage...` request reads, when the person may
 * use `permission` there. Same bind + authorize path as org billing: a slug
 * the person cannot reach is a 404, never a silent fall back to their signup
 * organization.
 */
async function resolveOrgUsageAccess(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
	permission: Extract<OrgPermission, 'billing:read' | 'billing:write'>
}): Promise<OrgUsageAccess> {
	const resolution = await loadRequestOrgResolution(
		input.request,
		input.env,
		input.user.mcpUser.userId,
	)
	if (typeof resolution === 'string') {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	const slug = resolution.org.slug ?? input.user.username
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			input.permission,
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return {
			ok: false,
			status: 403,
			error: `Only owners and billing admins can view usage for @${slug}.`,
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		throw new Error(`Cannot load usage: missing org ${resolution.org.id}.`)
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

function creditsRedirect(
	request: Request,
	slug: string,
	params: Record<string, string>,
) {
	const url = new URL(orgUsageCreditsPath(slug), request.url)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return Response.redirect(url.toString(), 302)
}

function renderUsageDenied(
	request: Request,
	env: Env,
	access: Extract<OrgUsageAccess, { ok: false }>,
) {
	return renderAppPage({
		request,
		env,
		title: access.status === 404 ? 'Organization unavailable' : 'Usage',
		...(access.status === 404 ? { notFound: true } : { unauthorized: true }),
		status: access.status,
	})
}

async function loadOrgUsagePageData(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
	org: BillingPageOrg
}) {
	const searchParams = new URL(input.request.url).searchParams
	return await loadAccountUsageData({
		env: input.env,
		userId: input.user.userId,
		org: input.org,
		notice: readMessage(creditsNoticeMessages, searchParams.get('credits')),
		error: readMessage(creditsErrorMessages, searchParams.get('error')),
	})
}

export function createOrgUsageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const access = await resolveOrgUsageAccess({
				request,
				env,
				user,
				permission: 'billing:read',
			})
			if (!access.ok) return renderUsageDenied(request, env, access)

			const searchParams = new URL(request.url).searchParams
			const sessionId = searchParams.get('session_id')?.trim()
			if (searchParams.get('topup') === 'success' && sessionId) {
				try {
					await applyCreditTopUpFromCheckoutSession({
						env,
						sessionId,
						expectedStableUserId: access.org.id,
						now: new Date(),
					})
					return creditsRedirect(request, access.org.slug, { credits: 'added' })
				} catch (error) {
					const code =
						error instanceof CreditTopUpError ? error.code : 'topup_failed'
					console.error('credit_top_up_confirm_failed', { code })
					return creditsRedirect(request, access.org.slug, {
						error: readMessage(creditsErrorMessages, code)
							? code
							: 'topup_failed',
					})
				}
			}

			const accountUsage = await loadOrgUsagePageData({
				request,
				env,
				user,
				org: access.org,
			})
			if (!accountUsage) {
				return new Response('Not found', { status: 404 })
			}
			return renderAppPage({
				request,
				env,
				title: 'Usage',
				loaderData: { accountUsage },
			})
		},
	} satisfies Action<typeof routes.orgUsage>
}

export function createOrgUsageApiHandler(env: Env) {
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
			const access = await resolveOrgUsageAccess({
				request,
				env,
				user,
				permission: 'billing:read',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			const accountUsage = await loadOrgUsagePageData({
				request,
				env,
				user,
				org: access.org,
			})
			if (!accountUsage) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			return jsonResponse(accountUsage)
		},
	} satisfies Action<typeof routes.orgUsageApi>
}

/** Personal-org usage URL for legacy `/account/usage` and `/account/credits`. */
export function personalOrgUsageRedirectUrl(input: {
	requestUrl: string
	slug: string
	/** When true, land on the Credits section (`#credits`). */
	credits?: boolean
}): string {
	const target = new URL(
		input.credits ? orgUsageCreditsPath(input.slug) : orgUsagePath(input.slug),
		input.requestUrl,
	)
	target.search = new URL(input.requestUrl).search
	return target.toString()
}
