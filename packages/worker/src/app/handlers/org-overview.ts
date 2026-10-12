import { type Action } from 'remix/router'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import { routes } from '#universal/routes.ts'

/**
 * Workspace overview for the signup organization: one page that links every
 * section it owns. A team org (members and grant-only collaborators alike)
 * already has that overview at its home, `/@slug`, so it redirects there.
 */
export function createOrgOverviewHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) return redirectToLogin(request)
			const resolution = await loadRequestOrgResolution(
				request,
				env,
				user.mcpUser.userId,
			)
			if (typeof resolution === 'string') {
				return renderAppPage({
					request,
					env,
					title: 'Organization unavailable',
					notFound: true,
					status: 404,
				})
			}
			const slug = resolution.org.slug ?? params.orgSlug
			if (resolution.org.id !== personalOrgId(user.mcpUser.userId)) {
				return Response.redirect(
					new URL(routes.profile.href({ username: slug }), request.url),
					302,
				)
			}
			const response = await renderAppPage({
				request,
				env,
				title: 'Overview',
			})
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
		},
	} satisfies Action<typeof routes.orgOverview>
}
