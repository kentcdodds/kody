import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import { resolveSignupMode } from '#app/signup-mode-setting.ts'
import { type routes } from '#universal/routes.ts'

export function createPricingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderAppPage({
				request,
				env,
				loaderData: {
					signupMode: await resolveSignupMode(env),
				},
			})
		},
	} satisfies Action<typeof routes.pricing>
}
