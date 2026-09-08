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
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { loadEnabledSiteBannersForSsr } from '#app/site-banner-ssr.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { resolveSignupMode } from '#app/signup-mode-setting.ts'
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
			const walkthroughHosts = pickWalkthroughHosts()
			// Start the banner list with auth and code-runs so signed-in /
			// (always no-store) does not pay that D1 after those finish.
			const listedBanners = loadEnabledSiteBannersForSsr(env)
			const [codeRunsWindow, signupMode, user] = await Promise.all([
				pushServerTiming(serverTiming, 'code-runs', () =>
					loadPublicCodeRunsWindow(env),
				),
				resolveSignupMode(env),
				readAuthenticatedAppUser(request, env, {
					prefetchFeatureFlags: true,
				}),
			])
			const codeRuns = { ok: true as const, window: codeRunsWindow }
			const onboarding = loadHomePageOnboardingData({
				env,
				requestUrl: request.url,
				user,
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
						listedBanners,
						serverTiming,
					}),
				),
				origin,
			)
		},
	} satisfies Action<typeof routes.home>
}
