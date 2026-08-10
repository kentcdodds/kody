import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createResetPasswordHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderAppPage({
				request,
				env,
			})
		},
	} satisfies Action<typeof routes.resetPassword>
}
