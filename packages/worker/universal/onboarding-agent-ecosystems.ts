/**
 * Product rule for onboarding Step 3: grey hosts in the same vendor family
 * as the agent the person started with, plus every named host already in
 * the Connected list. The second connect must be a different ecosystem so
 * Kody's shared home is the point — not a second client of the same
 * company, and not a host that is already authorized.
 *
 * `other` is an unknown vendor. It never shares a family with a named host,
 * and Not listed stays available for another unlisted connect.
 */

import { type McpClientKind } from '#universal/onboarding-mcp-clients.ts'

const onboardingAgentEcosystems = {
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

export type OnboardingSecondAgentDisableReason = 'same-ecosystem' | 'connected'

export type OnboardingGreyedSecondAgent = {
	id: McpClientKind
	reason: OnboardingSecondAgentDisableReason
}

export type OnboardingConnectedAgentKind = {
	kind?: McpClientKind | null
}

/**
 * Named chooser ids already in the Connected list. `other` / unknown
 * (`kind: null`) stay off this set — Not listed remains a path for a new
 * unlisted host.
 */
export function onboardingConnectedChooserKinds(
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind>,
): Array<McpClientKind> {
	const kinds = new Set<McpClientKind>()
	for (const agent of connectedAgents) {
		if (agent.kind && agent.kind !== 'other') kinds.add(agent.kind)
	}
	return [...kinds]
}

/**
 * Hosts Step 3 greys: the first-agent vendor family, plus every named host
 * already in the Connected list. Same-ecosystem wins when both apply.
 */
export function listOnboardingGreyedSecondAgents(
	firstAgent: McpClientKind | null,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): Array<OnboardingGreyedSecondAgent> {
	const greyed = new Map<McpClientKind, OnboardingSecondAgentDisableReason>()
	if (firstAgent) {
		for (const id of onboardingSameEcosystemAgents(firstAgent)) {
			greyed.set(id, 'same-ecosystem')
		}
	}
	for (const id of onboardingConnectedChooserKinds(connectedAgents)) {
		if (!greyed.has(id)) greyed.set(id, 'connected')
	}
	return [...greyed].map(([id, reason]) => ({ id, reason }))
}

export function onboardingGreyedSecondAgents(
	firstAgent: McpClientKind | null,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): Array<McpClientKind> {
	return listOnboardingGreyedSecondAgents(firstAgent, connectedAgents).map(
		(entry) => entry.id,
	)
}

export function isOnboardingSameEcosystemAgent(
	firstAgent: McpClientKind | null,
	candidate: McpClientKind,
): boolean {
	if (!firstAgent) return false
	return onboardingSameEcosystemAgents(firstAgent).includes(candidate)
}

export function onboardingSecondAgentDisableReason(
	candidate: McpClientKind,
	firstAgent: McpClientKind | null,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): OnboardingSecondAgentDisableReason | null {
	return (
		listOnboardingGreyedSecondAgents(firstAgent, connectedAgents).find(
			(entry) => entry.id === candidate,
		)?.reason ?? null
	)
}

export function onboardingSecondAgentDisableHint(
	reason: OnboardingSecondAgentDisableReason,
): string {
	switch (reason) {
		case 'same-ecosystem':
			return 'Same ecosystem'
		case 'connected':
			return 'Connected'
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}

function onboardingSecondAgentDisableTitle(
	reason: OnboardingSecondAgentDisableReason,
	firstAgent: McpClientKind | null,
	firstAgentLabel: string | null,
): string {
	switch (reason) {
		case 'same-ecosystem':
			return firstAgent && firstAgentLabel
				? onboardingSameEcosystemDisabledReason(firstAgent, firstAgentLabel)
				: "Pick a different ecosystem so Kody's home is portable."
		case 'connected':
			return 'Already connected. Pick a host that is not in your Connected list.'
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}

type OnboardingSecondAgentGreyedPresentation = {
	greyedAgents: Array<McpClientKind>
	greyedReasons: Partial<
		Record<McpClientKind, OnboardingSecondAgentDisableReason>
	>
	greyedTitles: Partial<Record<McpClientKind, string>>
}

export function onboardingSecondAgentGreyedPresentation(
	firstAgent: McpClientKind | null,
	firstAgentLabel: string | null,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): OnboardingSecondAgentGreyedPresentation {
	const entries = listOnboardingGreyedSecondAgents(firstAgent, connectedAgents)
	const greyedReasons: Partial<
		Record<McpClientKind, OnboardingSecondAgentDisableReason>
	> = {}
	const greyedTitles: Partial<Record<McpClientKind, string>> = {}
	for (const entry of entries) {
		greyedReasons[entry.id] = entry.reason
		greyedTitles[entry.id] = onboardingSecondAgentDisableTitle(
			entry.reason,
			firstAgent,
			firstAgentLabel,
		)
	}
	return {
		greyedAgents: entries.map((entry) => entry.id),
		greyedReasons,
		greyedTitles,
	}
}

/** Step 3 deep links to a greyed host fall back to the picker. */
export function resolveOnboardingStep3SelectedAgent(
	firstAgent: McpClientKind | null,
	selectedAgent: McpClientKind | null,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): McpClientKind | null {
	if (!selectedAgent) return null
	if (
		onboardingSecondAgentDisableReason(
			selectedAgent,
			firstAgent,
			connectedAgents,
		)
	) {
		return null
	}
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
