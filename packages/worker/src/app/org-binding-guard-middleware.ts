import { type Middleware } from 'remix/router'
import { renderIllustratedNotFoundPage } from '#app/handlers/error-pages.ts'
import { isOrgBoundPath, isOrgRequestDenied } from '#app/org-request-binding.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { loadResolvedRequestAuth } from './request-auth-cache.ts'

/**
 * Every org-bound request (`/@slug/-/…` and org-owned `/account/<section>.json`)
 * passes through here before its handler. An org the person cannot use is a
 * 404, never the signup org that `readAuthenticatedAppUser` would fall back to.
 * Signed-out and suspended requests continue so each handler keeps its own
 * login redirect or 401.
 */
export function createOrgBindingGuardMiddleware(env: Env): Middleware {
	return async ({ request, url }, next) => {
		if (!isOrgBoundPath(url.pathname)) return await next()
		const auth = await loadResolvedRequestAuth(request, env)
		if (!auth.user || auth.user.accountSuspended) return await next()
		if (!(await isOrgRequestDenied(request, env, auth.user.mcpUser.userId))) {
			return await next()
		}
		// Page form posts (MCP consent) read JSON too; only page loads get HTML.
		if (request.method === 'GET' && !url.pathname.endsWith('.json')) {
			return renderIllustratedNotFoundPage({ request, env })
		}
		return jsonResponse({ ok: false, error: 'Organization not found.' }, 404)
	}
}
