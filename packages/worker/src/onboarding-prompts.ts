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
		'Briefly explain what Kody can do.',
		`Then help me give Kody access to ${formatOnboardingFeaturedMcpChoice()}: call mcpServerAdd with one of ${formatOnboardingFeaturedMcpAddHint()}. If I already connected one on /onboarding, skip add and use mcpServerList. When the result includes an authUrl, ask me to open it and authorize, then check mcpServerList.`,
		'If none of those help, add a custom remote MCP server (name + URL) or skip to a zero-auth example.',
		'Do not start a bring-your-own-key walkthrough unless I ask.',
		'Smoke-test with one execute call against the connected tools, then persist that working code with packageSave.',
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
 * Onboarding Step 3 climax: one ad hoc execute against something they gave
 * Kody access to (or whatever they ask for if they skipped Step 2), then
 * persist that working code as a package they own.
 */
export function buildPersistFirstPackagePrompt(input: {
	env: OnboardingPromptEnv
	requestUrl: string | URL
	connectedWorkspaceLabel?: string | null
	installedExampleName?: string | null
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const step2Context = input.connectedWorkspaceLabel
		? `I gave Kody access to ${input.connectedWorkspaceLabel} from /onboarding Step 2.`
		: input.installedExampleName
			? `I installed ${input.installedExampleName} from /onboarding Step 2 Just try Kody.`
			: `I may have given Kody access on /onboarding Step 2, installed a zero-auth example, or skipped so I could try an ad hoc request first.`
	const executeHint = input.connectedWorkspaceLabel
		? `Use execute for one useful call against ${input.connectedWorkspaceLabel}.`
		: input.installedExampleName
			? `Use execute or a static import for one useful call against ${input.installedExampleName}.`
			: 'Use execute for one useful call (search Notion, list Linear issues, or ask me what I want if I skipped).'
	return [
		`Ask the connected Kody server to read ${origin}/guides/quick-example and help me with my first build.`,
		step2Context,
		`${executeHint} Show the result, then persist that working code with packageSave.`,
		'Explain that I own the package. Ask if I want a trigger (webhook, Kody app, cron, or skip) without recommending one.',
		'Keep messages short. Do not poll.',
	].join(' ')
}
