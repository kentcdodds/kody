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
import { getSignupMode } from '#universal/signup-mode.ts'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { loadPublicCodeRunsWindow } from '#worker/usage/code-runs-window.ts'
import { type routes } from '#universal/routes.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

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

			const serverTiming: Array<ServerTimingEntry> = []
			const codeRunsWindow = await pushServerTiming(
				serverTiming,
				'code-runs',
				() => loadPublicCodeRunsWindow(env),
			)
			const codeRuns = { ok: true as const, window: codeRunsWindow }
			const walkthroughHosts = pickWalkthroughHosts()
			const signupMode = getSignupMode(env)

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
								codeRuns,
								walkthroughHosts,
								signupMode,
							},
							serverTiming,
						}),
					),
					origin,
				)
			}

			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				username: user.username,
				emailVerified: user.emailVerified,
			})
			return withAgentDiscoveryLinkHeaders(
				withVaryAccept(
					await renderAppPage({
						request,
						env,
						loaderData: {
							onboarding,
							codeRuns,
							walkthroughHosts,
							signupMode,
						},
						serverTiming,
					}),
				),
				origin,
			)
		},
	} satisfies Action<typeof routes.home>
}
