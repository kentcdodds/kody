import { type Middleware } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	accountResourceRedirectPath,
	isAccountResourceRedirectPath,
} from '#universal/org-pages.ts'

/**
 * Short-lived redirects from `/account/...` resource pages to
 * `/@<signup slug>/...` (not last-used — storage still keys personal data by
 * person id). Person pages and JSON stay put. Removal is tracked by #3063.
 */
export function createOrgAccountRedirectMiddleware(env: Env): Middleware {
	return async ({ request, url }, next) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') return next()
		if (!isAccountResourceRedirectPath(url.pathname)) return next()
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) return next()
		const slug = user.request.org.slug || user.username
		const target = accountResourceRedirectPath(url.pathname, slug)
		if (!target) return next()
		const destination = new URL(target, url)
		destination.search = url.search
		return Response.redirect(destination.toString(), 302)
	}
}
