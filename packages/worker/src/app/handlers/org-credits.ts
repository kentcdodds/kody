import { type Action } from 'remix/router'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type BillingPageOrg } from '#app/account-billing-data.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import {
	decodeCreditLedgerCursor,
	InvalidCreditLedgerCursorError,
	loadOrgCreditsData,
} from '#app/org-credits-data.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

type OrgCreditsAccess =
	| { ok: true; org: BillingPageOrg; canReadBilling: boolean }
	| { ok: false }

/**
 * Any member, billing admin, or collaborator the URL org binds may open its
 * credits page. `billing:read` decides whether they see the wallet and
 * ledger or only their own budget. A slug the person cannot reach is a 404.
 */
async function resolveOrgCreditsAccess(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
}): Promise<OrgCreditsAccess> {
	const resolution = await loadRequestOrgResolution(
		input.request,
		input.env,
		input.user.mcpUser.userId,
	)
	if (typeof resolution === 'string') return { ok: false }
	let canReadBilling = true
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			'billing:read',
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		canReadBilling = false
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) return { ok: false }
	return {
		ok: true,
		canReadBilling,
		org: {
			id: resolution.org.id,
			slug: record.slug,
			displayName: record.display_name,
			personal:
				resolution.org.id === personalOrgIdForPerson(input.user.mcpUser),
		},
	}
}

async function loadForRequest(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
	access: Extract<OrgCreditsAccess, { ok: true }>
}) {
	const cursor = new URL(input.request.url).searchParams.get('cursor')
	return await loadOrgCreditsData({
		env: input.env,
		org: input.access.org,
		viewerUserId: input.user.mcpUser.userId,
		canReadBilling: input.access.canReadBilling,
		before: decodeCreditLedgerCursor(cursor),
	})
}

export function createOrgCreditsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const access = await resolveOrgCreditsAccess({ request, env, user })
			const notFound = () =>
				renderAppPage({
					request,
					env,
					title: 'Organization unavailable',
					notFound: true,
					status: 404,
				})
			if (!access.ok) return notFound()
			let orgCredits
			try {
				orgCredits = await loadForRequest({ request, env, user, access })
			} catch (error) {
				if (!(error instanceof InvalidCreditLedgerCursorError)) throw error
				const url = new URL(request.url)
				url.searchParams.delete('cursor')
				return Response.redirect(url.toString(), 302)
			}
			if (!orgCredits) return notFound()
			return renderAppPage({
				request,
				env,
				title: 'Credits',
				loaderData: { orgCredits },
			})
		},
	} satisfies Action<typeof routes.orgCredits>
}

export function createOrgCreditsApiHandler(env: Env) {
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
			const access = await resolveOrgCreditsAccess({ request, env, user })
			if (!access.ok) {
				return jsonResponse(
					{ ok: false, error: 'Organization unavailable.' },
					404,
				)
			}
			try {
				const orgCredits = await loadForRequest({ request, env, user, access })
				if (!orgCredits) {
					return jsonResponse({ ok: false, error: 'Not found.' }, 404)
				}
				return jsonResponse(orgCredits)
			} catch (error) {
				if (!(error instanceof InvalidCreditLedgerCursorError)) throw error
				return jsonResponse({ ok: false, error: error.message }, 400)
			}
		},
	} satisfies Action<typeof routes.orgCreditsApi>
}
