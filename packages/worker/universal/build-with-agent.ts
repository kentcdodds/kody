import { businessOnboardingHref } from './business-onboarding.ts'

/**
 * Public handoff for agents that may not have a Kody connection yet. With
 * `onboardingPage: false` the agent walks the person through connecting
 * from the public connection docs instead of sending them to `/onboarding`.
 */
export function buildWithAgentPrompt(
	options: { business?: boolean; onboardingPage?: boolean } = {},
) {
	const { business = false, onboardingPage = true } = options
	const connectionDocs =
		'Read https://kody.codes/auth.md and https://kody.codes/docs/connect-your-agent for the current connection instructions for this agent.'
	const connect = onboardingPage
		? `If Kody is not connected, help me get started at https://kody.codes${business ? businessOnboardingHref : '/onboarding'}. ${connectionDocs}`
		: `If Kody is not connected, walk me through connecting this agent. ${connectionDocs}`
	return [
		"Help me make something useful with Kody, Your agents' cloud.",
		`${connect} Let me complete sign-in and approve access myself. If you need a new chat or restart to load Kody tools, tell me what to do and wait until they are available.`,
		'Once connected, use Kody search({ entity: "guide:onboarding" }) to read the first-run guide. Ask what I want to accomplish, or offer the guide\'s first-win choices if I need ideas. Start with one small useful result and use the available Kody tools to build it. Inspect existing packages before creating anything new.',
		'Use secure connection flows for any accounts the work needs. Keep credentials out of chat and source code. Explain what the work will read or change, and get my approval before sending messages, deleting data, or publishing anything.',
		'Verify the result, show me where it lives, and explain how I can run or change it with this agent or another connected agent.',
	].join('\n\n')
}
