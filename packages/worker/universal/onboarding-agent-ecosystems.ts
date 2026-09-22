/**
 * Onboarding Step 3 counts a second agent by ecosystem, and the picker
 * groups hosts the same way. A tab is disabled only when a connected grant
 * is that host. An unlabeled client and a remembered picker choice do not
 * disable tabs and do not count as their own ecosystem.
 *
 * Cursor Local, Cursor Cloud, an unclassified Cursor grant, Grok Bot,
 * Grok.com, and Grok CLI share the Grok ecosystem. A Cursor Cloud grant also
 * marks Grok Bot connected, because Grok Bot uses that connection.
 */

import { type McpClientKind } from '#universal/onboarding-mcp-clients.ts'

const onboardingAgentEcosystems = {
	openai: ['chatgpt', 'codex'],
	anthropic: ['claude-desktop', 'claude-code'],
	xai: [
		'cursor',
		'cursor-local',
		'cursor-cloud',
		'grok-bot',
		'grok',
		'grok-cli',
	],
	github: ['copilot', 'copilot-app'],
	google: ['gemini'],
	cognition: ['devin'],
	sst: ['opencode'],
	openclaw: ['openclaw'],
	other: ['other'],
} as const satisfies Record<string, ReadonlyArray<McpClientKind>>

type OnboardingAgentEcosystemId = keyof typeof onboardingAgentEcosystems

const ecosystemByAgent = new Map<McpClientKind, OnboardingAgentEcosystemId>(
	(
		Object.entries(onboardingAgentEcosystems) as Array<
			[OnboardingAgentEcosystemId, ReadonlyArray<McpClientKind>]
		>
	).flatMap(([ecosystem, agents]) =>
		agents.map((agent) => [agent, ecosystem] as const),
	),
)

function onboardingAgentEcosystem(
	agent: McpClientKind,
): OnboardingAgentEcosystemId {
	const ecosystem = ecosystemByAgent.get(agent)
	if (!ecosystem) {
		throw new Error(`Unknown onboarding agent ${agent}`)
	}
	return ecosystem
}

function onboardingSameEcosystemAgents(
	agent: McpClientKind,
): ReadonlyArray<McpClientKind> {
	return onboardingAgentEcosystems[onboardingAgentEcosystem(agent)]
}

export type OnboardingStep3EcosystemGroup = {
	id: OnboardingAgentEcosystemId
	label: string
	agents: ReadonlyArray<McpClientKind>
}

/**
 * Step 3 chooser. Generic `cursor` stays off this list: that kind means we
 * could not tell Local from Cloud, so neither tab is the one we know.
 */
export const onboardingStep3EcosystemGroups = [
	{
		id: 'xai',
		label: 'Grok',
		agents: ['cursor-local', 'cursor-cloud', 'grok-bot', 'grok', 'grok-cli'],
	},
	{
		id: 'anthropic',
		label: 'Claude',
		agents: ['claude-code', 'claude-desktop'],
	},
	{
		id: 'openai',
		label: 'ChatGPT',
		agents: ['chatgpt', 'codex'],
	},
	{
		id: 'github',
		label: 'GitHub',
		agents: ['copilot', 'copilot-app'],
	},
	{
		id: 'google',
		label: 'Gemini',
		agents: ['gemini'],
	},
	{
		id: 'cognition',
		label: 'Devin',
		agents: ['devin'],
	},
	{
		id: 'sst',
		label: 'OpenCode',
		agents: ['opencode'],
	},
	{
		id: 'openclaw',
		label: 'OpenClaw',
		agents: ['openclaw'],
	},
	{
		id: 'other',
		label: 'Another host',
		agents: ['other'],
	},
] as const satisfies ReadonlyArray<OnboardingStep3EcosystemGroup>

export function onboardingStep3AgentIds(): Array<McpClientKind> {
	return onboardingStep3EcosystemGroups.flatMap((group) => [...group.agents])
}

export type OnboardingSecondAgentDisableReason = 'connected'

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
 * Distinct ecosystems among grants we can name. Unlabeled clients and
 * `other` add nothing. Cursor and Grok hosts are one ecosystem.
 */
export function countConnectedAgentEcosystems(
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind>,
): number {
	const ecosystems = new Set<OnboardingAgentEcosystemId>()
	for (const kind of onboardingConnectedChooserKinds(connectedAgents)) {
		ecosystems.add(onboardingAgentEcosystem(kind))
	}
	return ecosystems.size
}

/** True when two known ecosystems are connected. */
export function hasSecondConnectedMcpClient(
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind>,
): boolean {
	return countConnectedAgentEcosystems(connectedAgents) >= 2
}

export function hasSecondAgentEcosystem(ecosystemCount: number) {
	return ecosystemCount >= 2
}

/**
 * Hosts Step 3 disables: named grants we already classified, plus Grok Bot
 * when Cursor Cloud is connected.
 */
export function listOnboardingGreyedSecondAgents(
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): Array<OnboardingGreyedSecondAgent> {
	const known = onboardingConnectedChooserKinds(connectedAgents)
	const greyed = new Map<McpClientKind, OnboardingSecondAgentDisableReason>()
	for (const id of known) {
		greyed.set(id, 'connected')
	}
	if (known.includes('cursor-cloud')) {
		greyed.set('grok-bot', 'connected')
	}
	return [...greyed].map(([id, reason]) => ({ id, reason }))
}

export function onboardingGreyedSecondAgents(
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): Array<McpClientKind> {
	return listOnboardingGreyedSecondAgents(connectedAgents).map(
		(entry) => entry.id,
	)
}

export function isOnboardingSameEcosystemAgent(
	firstAgent: McpClientKind | null,
	candidate: McpClientKind,
): boolean {
	if (!firstAgent || firstAgent === 'other') return false
	return onboardingSameEcosystemAgents(firstAgent).includes(candidate)
}

export function onboardingSecondAgentDisableReason(
	candidate: McpClientKind,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): OnboardingSecondAgentDisableReason | null {
	return (
		listOnboardingGreyedSecondAgents(connectedAgents).find(
			(entry) => entry.id === candidate,
		)?.reason ?? null
	)
}

export function onboardingSecondAgentDisableHint(
	reason: OnboardingSecondAgentDisableReason,
): string {
	switch (reason) {
		case 'connected':
			return 'Connected'
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}

function onboardingSecondAgentDisableTitle(
	id: McpClientKind,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind>,
): string {
	const known = onboardingConnectedChooserKinds(connectedAgents)
	if (
		id === 'grok-bot' &&
		known.includes('cursor-cloud') &&
		!known.includes('grok-bot')
	) {
		return 'Connected with Cursor Cloud. Grok Bot uses that connection.'
	}
	return 'Already connected.'
}

type OnboardingSecondAgentGreyedPresentation = {
	greyedAgents: Array<McpClientKind>
	greyedReasons: Partial<
		Record<McpClientKind, OnboardingSecondAgentDisableReason>
	>
	greyedTitles: Partial<Record<McpClientKind, string>>
}

export function onboardingSecondAgentGreyedPresentation(
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): OnboardingSecondAgentGreyedPresentation {
	const entries = listOnboardingGreyedSecondAgents(connectedAgents)
	const greyedReasons: Partial<
		Record<McpClientKind, OnboardingSecondAgentDisableReason>
	> = {}
	const greyedTitles: Partial<Record<McpClientKind, string>> = {}
	for (const entry of entries) {
		greyedReasons[entry.id] = entry.reason
		greyedTitles[entry.id] = onboardingSecondAgentDisableTitle(
			entry.id,
			connectedAgents,
		)
	}
	return {
		greyedAgents: entries.map((entry) => entry.id),
		greyedReasons,
		greyedTitles,
	}
}

/** Step 3 deep links to a known-connected host fall back to the picker. */
export function resolveOnboardingStep3SelectedAgent(
	selectedAgent: McpClientKind | null,
	connectedAgents: ReadonlyArray<OnboardingConnectedAgentKind> = [],
): McpClientKind | null {
	if (!selectedAgent) return null
	if (onboardingSecondAgentDisableReason(selectedAgent, connectedAgents)) {
		return null
	}
	return selectedAgent
}
