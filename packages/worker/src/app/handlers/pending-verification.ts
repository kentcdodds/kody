import { type Action } from 'remix/router'
import {
	normalizeRedirectTo,
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
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
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
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
