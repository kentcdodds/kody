import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { personalOrgUsageRedirectUrl } from '#app/handlers/org-usage.ts'
import { type routes } from '#universal/routes.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

/**
 * Legacy `/account/usage` → personal-org `/@slug/-/usage`, keeping the query
 * so Stripe top-up returns (`?topup=success&session_id=…`) and notice codes
 * still resolve on the org usage page. The browser re-applies `#credits`.
 */
async function personalUsageSlug(env: Env, user: AuthenticatedAppUser) {
	const signupOrg = await getOrgById(
		env.APP_DB,
		personalOrgId(user.mcpUser.userId),
	)
	return signupOrg?.slug?.trim() || user.username
}

export function createAccountUsageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const slug = await personalUsageSlug(env, user)
			return Response.redirect(
				personalOrgUsageRedirectUrl({ requestUrl: request.url, slug }),
				302,
			)
		},
	} satisfies Action<typeof routes.accountUsage>
}

/**
 * Legacy `/account/usage.json` → personal-org usage JSON. Kept so existing
 * clients keep working until they switch to `/@:orgSlug/-/usage.json`.
 */
export function createAccountUsageApiHandler(env: Env) {
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
			const slug = await personalUsageSlug(env, user)
			const target = new URL(`/@${slug}/-/usage.json`, request.url)
			target.search = new URL(request.url).search
			return Response.redirect(target.toString(), 302)
		},
	} satisfies Action<typeof routes.accountUsageApi>
}
