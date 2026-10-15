import { type Action } from 'remix/router'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
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
			if (resolution.org.id !== personalOrgIdForPerson(user.mcpUser)) {
				return Response.redirect(
					new URL(routes.profile.href({ username: slug }), request.url),
					302,
				)
			}
			return renderAppPage({
				request,
				env,
				title: 'Overview',
			})
		},
	} satisfies Action<typeof routes.orgOverview>
}
