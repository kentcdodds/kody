import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { createPageOgHeadNode } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createHomeHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const origin = getAppBaseUrl({ env, requestUrl: request.url })
			const extraHead = createPageOgHeadNode({ origin, pageId: 'home' })
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return renderAppPage({ request, env, extraHead })
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
				extraHead,
				loaderData: { onboarding },
			})
		},
	} satisfies Action<typeof routes.home>
}
