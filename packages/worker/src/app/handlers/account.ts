import { type Action } from 'remix/router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createAccountHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session } = await readAuthSessionResult(request)

			if (!session) {
				return redirectToLogin(request)
			}

			return renderAppPage({
				request,
				env,
				title: 'Account',
			})
		},
	} satisfies Action<typeof routes.account>
}
