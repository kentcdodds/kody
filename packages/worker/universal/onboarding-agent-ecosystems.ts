/**
 * Product rule for onboarding Step 3: grey hosts in the same vendor family
 * as the agent the person started with. The second connect must be a
 * different ecosystem so Kody's shared home is the point — not a second
 * client of the same company.
 *
 * `other` is an unknown vendor. It never shares a family with a named host.
 */

import { type McpClientKind } from '#universal/onboarding-mcp-clients.ts'

export const onboardingAgentEcosystems = {
	openai: ['chatgpt', 'codex'],
	anthropic: ['claude-desktop', 'claude-code'],
	xai: ['grok', 'grok-cli', 'grok-bot'],
	github: ['copilot', 'copilot-app'],
	cursor: ['cursor'],
	google: ['gemini'],
	cognition: ['devin'],
	sst: ['opencode'],
	openclaw: ['openclaw'],
	other: ['other'],
} as const satisfies Record<string, ReadonlyArray<McpClientKind>>

export type OnboardingAgentEcosystemId = keyof typeof onboardingAgentEcosystems

const ecosystemByAgent = new Map<McpClientKind, OnboardingAgentEcosystemId>(
	(
		Object.entries(onboardingAgentEcosystems) as Array<
			[OnboardingAgentEcosystemId, ReadonlyArray<McpClientKind>]
		>
	).flatMap(([ecosystem, agents]) =>
		agents.map((agent) => [agent, ecosystem] as const),
	),
)

export function onboardingAgentEcosystem(
	agent: McpClientKind,
): OnboardingAgentEcosystemId {
	const ecosystem = ecosystemByAgent.get(agent)
	if (!ecosystem) {
		throw new Error(`Unknown onboarding agent ${agent}`)
	}
	return ecosystem
}

export function onboardingSameEcosystemAgents(
	agent: McpClientKind,
): ReadonlyArray<McpClientKind> {
	return onboardingAgentEcosystems[onboardingAgentEcosystem(agent)]
}

/**
 * Hosts Step 3 greys. Named first agents grey their vendor family.
 * `other` only greys itself — we do not know that vendor.
 */
export function onboardingGreyedSecondAgents(
	firstAgent: McpClientKind | null,
): ReadonlyArray<McpClientKind> {
	if (!firstAgent) return []
	return onboardingSameEcosystemAgents(firstAgent)
}

export function isOnboardingSameEcosystemAgent(
	firstAgent: McpClientKind | null,
	candidate: McpClientKind,
): boolean {
	return onboardingGreyedSecondAgents(firstAgent).includes(candidate)
}

/** Step 3 deep links to a same-ecosystem host fall back to the picker. */
export function resolveOnboardingStep3SelectedAgent(
	firstAgent: McpClientKind | null,
	selectedAgent: McpClientKind | null,
): McpClientKind | null {
	if (!selectedAgent) return null
	if (isOnboardingSameEcosystemAgent(firstAgent, selectedAgent)) return null
	return selectedAgent
}

export function onboardingSameEcosystemDisabledReason(
	firstAgent: McpClientKind,
	firstAgentLabel: string,
): string {
	const family = onboardingSameEcosystemAgents(firstAgent)
	if (family.length === 1) {
		return `You started with ${firstAgentLabel}. Pick a different ecosystem so Kody's home is portable.`
	}
	return `Same ecosystem as ${firstAgentLabel}. Pick a different vendor so Kody's home is portable.`
}
