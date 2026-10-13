import { type Middleware } from 'remix/router'
import { isSecureRequest } from '#app/auth-session.ts'
import { renderIllustratedNotFoundPage } from '#app/handlers/error-pages.ts'
import {
	isOrgBoundPath,
	isOrgRequestDenied,
	loadRequestOrgResolution,
} from '#app/org-request-binding.ts'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import { orgOwnedAccountApiSection } from '#universal/org-pages.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { loadResolvedRequestAuth } from './request-auth-cache.ts'

/**
 * Every org-bound request (`/@slug/-/…` and org-owned `/account/<section>.json`)
 * passes through here before its handler. An org the person cannot use is a
 * 404, never the signup org that `readAuthenticatedAppUser` would fall back to.
 * Signed-out and suspended requests continue so each handler keeps its own
 * login redirect or 401.
 *
 * Client-router navigation loads org pages via `/account/<section>.json` with
 * the `/@slug/-/…` page as Referer. Those JSON responses never hit the
 * full-document org handlers that write `kody_last_org`, so remember the bound
 * org here the same way a full load does (#3517).
 */
export function createOrgBindingGuardMiddleware(env: Env): Middleware {
	return async ({ request, url }, next) => {
		if (!isOrgBoundPath(url.pathname)) return await next()
		const auth = await loadResolvedRequestAuth(request, env)
		if (!auth.user || auth.user.accountSuspended) return await next()
		if (await isOrgRequestDenied(request, env, auth.user.mcpUser.userId)) {
			// Page form posts (MCP consent) read JSON too; only page loads get HTML.
			if (request.method === 'GET' && !url.pathname.endsWith('.json')) {
				return renderIllustratedNotFoundPage({ request, env })
			}
			return jsonResponse({ ok: false, error: 'Organization not found.' }, 404)
		}
		const response = await next()
		if (orgOwnedAccountApiSection(url.pathname) === null) return response
		const resolution = await loadRequestOrgResolution(
			request,
			env,
			auth.user.mcpUser.userId,
		)
		if (resolution === 'denied' || resolution === 'personal') return response
		const slug = resolution.org.slug
		if (!slug) return response
		const headers = new Headers(response.headers)
		headers.append(
			'Set-Cookie',
			serializeLastUsedOrgCookie({
				slug,
				secure: isSecureRequest(request),
			}),
		)
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}
}
