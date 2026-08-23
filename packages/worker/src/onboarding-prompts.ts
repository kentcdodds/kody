import {
	formatOnboardingFeaturedMcpAddHint,
	formatOnboardingFeaturedMcpChoice,
} from '#universal/onboarding-mcp-chooser.ts'
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
		`Then help me connect ${formatOnboardingFeaturedMcpChoice()} as a remote MCP server: call mcp_server_add with one of ${formatOnboardingFeaturedMcpAddHint()}. If I already connected one on /onboarding, skip add and use mcp_server_list. When the result includes an authUrl, ask me to open it and authorize Kody, then check mcp_server_list.`,
		'Do not offer GitHub official MCP as the first option — it does not return an authorization URL.',
		'Do not create any packages until one connected server works — start with a small ad hoc execute smoke test against its tools (for example search Notion, list Linear issues, or list Slack channels).',
		'Once that ad hoc call works, persist the working code as a package I own with package_save, or community_fork the matching official @kody listing if one is closer. Only create a new package if nothing suitable exists.',
	].join(' ')
}

/**
 * Discovery prompt for people who have not connected (or signed up) yet. It
 * only assumes the agent can fetch a URL: the interview steering lives in
 * the `what-is-kody` guide itself (as embedded notes for agents), so the
 * prompt stays short enough to read before pasting. The parenthetical
 * identifies this deployment (kody.codes in production).
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
 * Optional email → reply → memories loop. Onboarding Step 3 uses the persist
 * playbook instead; this MCP prompt remains for people who want that path.
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
		`Ask the connected Kody server to read ${origin}/guides/first-win and then walk me through the optional email-and-memories loop, one step at a time.`,
		'Start by sending the welcome email, then tell me exactly what to do in my own inbox.',
		"Do not poll or wait for my reply — I'll come back to this chat and tell you when I have replied.",
	].join(' ')
}

/**
 * Onboarding Step 3 climax: one ad hoc execute against a connected MCP server
 * (or whatever the person asks for if they skipped Step 2), then persist that
 * working code as a package they own.
 */
export function buildPersistFirstPackagePrompt(input: {
	env: OnboardingPromptEnv
	requestUrl: string | URL
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return [
		`Ask the connected Kody server to read ${origin}/guides/quick-example and help me with my first build on Kody.`,
		`I connected ${formatOnboardingFeaturedMcpChoice()} as a remote MCP server from /onboarding Step 2, or skipped so I could try an ad hoc request first.`,
		'Use execute for one useful ad hoc call (search Notion, list Linear issues, list Slack channels, or ask me what I want if I skipped). Show the result, then persist that working code as a package I own with package_save — or community_fork the matching official @kody listing if one is closer.',
		'Explain that I own the package. Ask if I want a trigger (webhook, Kody app, cron, or skip) without recommending one.',
		'Keep messages short. Do not poll.',
	].join(' ')
}
