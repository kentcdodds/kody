import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createHomeHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return renderAppPage({ request, env })
			}

			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				emailVerified: user.emailVerified,
			})
			return renderAppPage({
				request,
				env,
				loaderData: { onboarding },
			})
		},
	} satisfies Action<typeof routes.home>
}
