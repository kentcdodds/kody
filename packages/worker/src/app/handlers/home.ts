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
			if (!user) {
				// Anonymous visits still embed discovery-prompt copy so the
				// hero does not pop it in after /onboarding.json. The MCP
				// chooser catalog and setup prompts stay off / — home does
				// not render them, and they dominated rmx-data (~7 kB).
				return withAgentDiscoveryLinkHeaders(
					withVaryAccept(
						await renderAppPage({
							request,
							env,
							loaderData: {
								onboarding: {
									...loadPublicOnboardingData({
										env,
										requestUrl: request.url,
									}),
									featuredMcpServers: [],
									setupPrompt: '',
									persistPrompt: '',
								},
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
				featuredMcpServers: [],
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
