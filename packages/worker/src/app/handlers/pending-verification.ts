import { type Action } from 'remix/router'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

function resolvePostVerificationRedirect(request: Request) {
	const redirectTo = normalizeRedirectTo(
		new URL(request.url).searchParams.get('redirectTo'),
	)
	return new URL(redirectTo ?? '/onboarding', request.url)
}

export function createPendingVerificationHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			if (user.emailVerified) {
				return Response.redirect(resolvePostVerificationRedirect(request), 302)
			}

			return renderAppPage({
				request,
				env,
				title: 'Verify your email',
				loaderData: {
					pendingVerification: {
						ok: true,
						email: user.email,
					},
				},
			})
		},
	} satisfies Action<typeof routes.pendingVerification>
}
