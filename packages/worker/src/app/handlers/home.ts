import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	buildHomeMarkdown,
	withAgentDiscoveryLinkHeaders,
} from '#app/agent-discovery.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadLandingHeroVideos } from '#app/landing-hero-videos.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { loadHomePageOnboardingData } from '#app/onboarding-data.ts'
import { loadEnabledSiteBannersForSsr } from '#app/site-banner-ssr.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
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

			const walkthroughHosts = pickWalkthroughHosts()
			// Start the banner list and hero playlist with auth so signed-in
			// / (always no-store) does not pay those after auth finishes.
			const listedBanners = loadEnabledSiteBannersForSsr(env)
			const landingHeroVideos = loadLandingHeroVideos({ env })
			const user = await readAuthenticatedAppUser(request, env, {
				prefetchFeatureFlags: true,
			})
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
							walkthroughHosts,
							landingHeroVideos: await landingHeroVideos,
						},
						listedBanners,
					}),
				),
				origin,
			)
		},
	} satisfies Action<typeof routes.home>
}
