import { getAppBaseUrl } from '#worker/app-base-url.ts'

/**
 * Templated onboarding prompts shared by the browser onboarding UI and MCP
 * `prompts/list` + `prompts/get`. Lives in `#worker/*` so both the app layer
 * and MCP registration can import it without crossing import boundaries.
 */

type OnboardingPromptEnv = {
	APP_BASE_URL?: string | null
}

export function buildMcpServerUrl(input: {
	env: OnboardingPromptEnv
	requestUrl: string | URL
}) {
	return `${getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})}/mcp`
}

export function buildOnboardingSetupPrompt() {
	return [
		'Help me get started with Kody.',
		'First, briefly explain what Kody can do for me in plain language.',
		'Then help me connect one integration I care about: check coding_guide_get for a matching provider guide (for example provider_github or provider_google) and follow it; otherwise use search and the official guides to find the right setup steps, walk me through the connect or secrets flow, and verify the connection with a small ad hoc execute smoke test.',
		'Do not create any packages until the integration works — start with ad hoc execute calls.',
		'Once the integration works, check community_search for a trusted community package that is close to what I want, fork or adapt it (community_fork, or point me at one-click install on /onboarding or the listing detail), and only create a new package if nothing suitable exists.',
	].join(' ')
}

/**
 * Discovery prompt for people who have not connected (or signed up) yet. It
 * only assumes the agent can fetch a URL: the interview steering lives in
 * the `what-is-kody` guide itself (as embedded notes for agents), so the
 * prompt stays short enough to read before pasting. The parenthetical
 * identifies this deployment (heykody.app in production).
 */
export function buildDiscoveryPrompt(input: {
	env: OnboardingPromptEnv
	requestUrl: string | URL
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return [
		`I'm deciding whether Kody (${origin}) would be useful for me.`,
		`Read ${origin}/guides/what-is-kody and then interview me to find out what Kody could do for me.`,
		"Don't set anything up yet — this works before I have an account.",
	].join(' ')
}

/**
 * The whole first win in one paste: the agent owns the loop (send the welcome
 * email, hand off to the person's own inbox, look the reply up when they say
 * so, save memories), and the steering for each part lives in the `first-win`
 * guide as embedded notes for agents rather than in the prompt.
 *
 * Address the connected Kody server rather than "Hey Kody" — some hosts treat
 * that as impersonation / prompt injection and skip MCP tools. The no-polling
 * sentence stays in the prompt too, because an agent that busy-waits for the
 * reply is the failure people notice first.
 */
export function buildFirstWinPrompt(input: {
	env: OnboardingPromptEnv
	requestUrl: string | URL
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return [
		`Ask the connected Kody server to read ${origin}/guides/first-win and then walk me through my first win with Kody, one step at a time.`,
		'Start by sending the welcome email, then tell me exactly what to do in my own inbox.',
		"Do not poll or wait for my reply — I'll come back to this chat and tell you when I have replied.",
	].join(' ')
}
