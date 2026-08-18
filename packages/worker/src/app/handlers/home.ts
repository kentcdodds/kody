import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	buildHomeMarkdown,
	withAgentDiscoveryLinkHeaders,
} from '#app/agent-discovery.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import {
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createHomeHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const origin = getAppBaseUrl({ env, requestUrl: request.url })
			if (prefersMarkdown(request)) {
				return withAgentDiscoveryLinkHeaders(
					markdownResponse(buildHomeMarkdown(origin)),
					origin,
				)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				// Anonymous visits still embed the public onboarding payload so
				// the hero's discovery-prompt copy renders server-side instead
				// of popping in after a client /onboarding.json fetch.
				return withAgentDiscoveryLinkHeaders(
					withVaryAccept(
						await renderAppPage({
							request,
							env,
							loaderData: {
								onboarding: loadPublicOnboardingData({
									env,
									requestUrl: request.url,
								}),
							},
						}),
					),
					origin,
				)
			}

			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				emailVerified: user.emailVerified,
			})
			return withAgentDiscoveryLinkHeaders(
				withVaryAccept(
					await renderAppPage({
						request,
						env,
						loaderData: { onboarding },
					}),
				),
				origin,
			)
		},
	} satisfies Action<typeof routes.home>
}
