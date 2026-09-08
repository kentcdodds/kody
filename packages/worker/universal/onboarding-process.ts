/**
 * Onboarding wizard, derived checklist, and first-win alignment. Client UI,
 * MCP search notices, and `docs/guides/first-win.md` all read from here so a
 * wizard change fails the alignment check until the guide is updated.
 */

import {
	type McpClientKind,
	isMcpClientKind,
} from '#universal/onboarding-mcp-clients.ts'
import { routes } from '#universal/routes.ts'

export const onboardingStepPaths = {
	index: '/onboarding',
	step1: '/onboarding/step-1',
	step1Agent: '/onboarding/step-1/:agent',
	step2: '/onboarding/step-2',
	step2Service: '/onboarding/step-2/:service',
	step3: '/onboarding/step-3',
	step3Agent: '/onboarding/step-3/:agent',
} as const

const onboardingNotListedSegment = 'not-listed'

export const onboardingWizardSteps = [
	{
		number: 1,
		path: onboardingStepPaths.step1,
		panelId: 'onboarding-step-1',
		label: 'Connect your agent',
	},
	{
		number: 2,
		path: onboardingStepPaths.step2,
		panelId: 'onboarding-step-2',
		label: 'Make something useful',
	},
	{
		number: 3,
		path: onboardingStepPaths.step3,
		panelId: 'onboarding-step-3',
		label: 'Connect a second agent',
	},
] as const

export type OnboardingWizardStepNumber =
	(typeof onboardingWizardSteps)[number]['number']

export type OnboardingLocation = {
	step: OnboardingWizardStepNumber
	agent: McpClientKind | null
	valid: boolean
}

export const onboardingChecklistItems = [
	{
		id: 'verify-email',
		label: 'Verify your email',
		href: '/pending-verification',
	},
	{
		id: 'connect-agent',
		label: 'Connect your agent',
		wizardStep: 1,
	},
	{
		id: 'give-access',
		label: 'Make something useful',
		wizardStep: 2,
	},
	{
		id: 'connect-second-agent',
		label: 'Connect a second agent',
		wizardStep: 3,
	},
	{
		id: 'install-starter',
		label: 'Persist your first package',
		profile: true,
	},
] as const

export type OnboardingChecklistItemId =
	(typeof onboardingChecklistItems)[number]['id']

export type OnboardingChecklistItem = {
	id: OnboardingChecklistItemId
	done: boolean
}

export const onboardingChecklistItemLabels = Object.fromEntries(
	onboardingChecklistItems.map((item) => [item.id, item.label]),
) as Record<OnboardingChecklistItemId, string>

export const onboardingUnconnectedNotice =
	'Your agent cannot do anything in Kody yet.'

/** Agent-retrievable first-run guide (bundled + `search({ entity })`). */
const onboardingGuideEntity = 'onboarding:guide'
export const onboardingGuideHref = '/guides/onboarding'

/** Agent-retrievable Step 3 reuse guide (bundled + `search({ entity })`). */
export const portabilityGuideSlug = 'portability'
export const portabilityGuideEntity = 'portability:guide'
export const portabilityGuideHref = '/guides/portability'

export const onboardingAccessLede =
	'Kody is the home your agents share — memory, secrets, packages, jobs, workflows, and apps. Paste this prompt so your agent looks up the onboarding guide and helps you make something useful. It is not a service gateway.'

export function onboardingAccessSelectedLede(agentLabel: string | null) {
	const name = agentLabel?.trim() ? agentLabel.trim() : 'your agent'
	return `Copy this prompt into ${name}. It will look up the onboarding guide, ask 1–2 questions to find your use, and help you make something useful in Kody.`
}

export const onboardingStep2Prompt = [
	"I'm on Kody onboarding Step 2.",
	`Look up the onboarding guide with search({ entity: "${onboardingGuideEntity}" }) and help me make something useful in my account.`,
	'Follow the guide.',
].join(' ')

export const onboardingCopyStep2PromptLabel = 'Copy Step 2 prompt'

export const onboardingSearchWaitingLabel =
	'Waiting for your agent to look up the onboarding guide…'

/** Completes for first search or an existing access win (memory / execute / package). */
export const onboardingSearchStartedLabel =
	"You've started making something useful"

const onboardingSecondAgentGiftAdvertise =
	'Connect a second agent and get Standard free for 2 weeks.'

export const onboardingSecondAgentLede = `Connect an agent from a different ecosystem. Reuse what you made in Step 2 so you can see it travel. ${onboardingSecondAgentGiftAdvertise}`

export const onboardingPortabilityProofPrompt = [
	'I just connected you as a second agent.',
	`Look up the portability guide with search({ entity: "${portabilityGuideEntity}" }) and reuse what I made in Step 2.`,
	'One short proof.',
].join(' ')

/** Chip-length cap so Step 3 "You made …" stays one short line. */
const onboardingAccessWinChipMaxLength = 48

function truncateOnboardingAccessWinChip(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return ''
	if (trimmed.length <= onboardingAccessWinChipMaxLength) return trimmed
	return `${trimmed.slice(0, onboardingAccessWinChipMaxLength - 1)}…`
}

function onboardingAccessWinPackageChip(packageName?: string | null) {
	const name = packageName?.trim() ?? ''
	// Saved-package names are `@scope/kody-id`. A bare kody id is not a
	// sensible chip, so hide that half rather than invent a label.
	if (!name.startsWith('@') || !name.includes('/')) return ''
	return truncateOnboardingAccessWinChip(name)
}

export function onboardingAccessWinMadeLine(input: {
	memorySubject?: string | null
	packageName?: string | null
}) {
	const memory = truncateOnboardingAccessWinChip(input.memorySubject ?? '')
	const packageName = onboardingAccessWinPackageChip(input.packageName)
	if (memory && packageName) return `You made ${memory} and ${packageName}`
	if (memory) return `You made ${memory}`
	if (packageName) return `You made ${packageName}`
	return null
}

export const onboardingCopyPortabilityProofLabel = 'Copy portability proof'

const onboardingSecondAgentConnectedLabel = "You've connected a second agent."

const onboardingSecondAgentConnectedGiftLabel =
	"You've connected a second agent. Standard is free for 2 weeks."

export function onboardingSecondAgentConnectedStatusLabel(giftActive: boolean) {
	return giftActive
		? onboardingSecondAgentConnectedGiftLabel
		: onboardingSecondAgentConnectedLabel
}

export type OnboardingConnectedAgentListItem = {
	label: string
	kind?: McpClientKind | null
}

export function uniqueOnboardingConnectedAgents(
	agents: ReadonlyArray<OnboardingConnectedAgentListItem>,
): Array<{ label: string; kind: McpClientKind | null }> {
	const seen = new Set<string>()
	const unique = new Array<{ label: string; kind: McpClientKind | null }>()
	for (const agent of agents) {
		const label = agent.label.trim()
		if (!label || seen.has(label)) continue
		seen.add(label)
		unique.push({ label, kind: agent.kind ?? null })
	}
	return unique
}

/**
 * Step 1 identity for Step 2 copy and Step 3 greying. Prefer the explicit
 * picker choice; on return visits fall back to the earliest dated named
 * inbound host so a cleared session still names Cursor / Claude Desktop.
 */
export function resolveOnboardingFirstAgentKind(
	remembered: McpClientKind | null | undefined,
	connectedAgents: ReadonlyArray<{
		kind?: McpClientKind | null
		connectedAt?: string | null
	}> = [],
): McpClientKind | null {
	if (remembered && remembered !== 'other') return remembered
	let oldest: { kind: McpClientKind; connectedAt: string } | null = null
	for (const agent of connectedAgents) {
		const kind = agent.kind
		const connectedAt = agent.connectedAt
		if (!kind || kind === 'other' || !connectedAt) continue
		if (!oldest || connectedAt < oldest.connectedAt) {
			oldest = { kind, connectedAt }
		}
	}
	return oldest?.kind ?? null
}

export function onboardingConnectedListSeparator(
	index: number,
	length: number,
): string {
	if (index === 0) return ''
	if (length === 2) return ' and '
	if (index === length - 1) return ', and '
	return ', '
}

export function onboardingConnectedAgentLabelsLine(
	agents: ReadonlyArray<OnboardingConnectedAgentListItem>,
) {
	const labels = uniqueOnboardingConnectedAgents(agents).map(
		(agent) => agent.label,
	)
	if (labels.length === 0) return null
	if (labels.length === 1) return `Connected: ${labels[0]}`
	if (labels.length === 2) return `Connected: ${labels[0]} and ${labels[1]}`
	return `Connected: ${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
}

export type OnboardingWizardProgress = {
	hasMcpClient: boolean
	hasAccessWin: boolean
	hasSecondMcpClient: boolean
}

/**
 * First unfinished wizard step. Finished accounts resume on Step 3 so the
 * Connected list stays visible instead of a fresh Step 1 picker.
 */
export function resumeOnboardingWizardStep(
	progress: OnboardingWizardProgress,
): OnboardingWizardStepNumber {
	if (!progress.hasMcpClient) return 1
	if (!progress.hasAccessWin) return 2
	return 3
}

export function remainingOnboardingWizardLabels(
	input: OnboardingWizardProgress,
): Array<string> {
	const remaining: Array<string> = []
	if (!input.hasMcpClient) {
		remaining.push(onboardingWizardStepByNumber(1).label)
	}
	if (!input.hasAccessWin) {
		remaining.push(onboardingWizardStepByNumber(2).label)
	}
	if (!input.hasSecondMcpClient) {
		remaining.push(onboardingWizardStepByNumber(3).label)
	}
	return remaining
}

export function formatOnboardingSearchNotice(
	remainingLabels: ReadonlyArray<string>,
	baseUrl: string,
): string | null {
	if (remainingLabels.length === 0) return null
	const count = remainingLabels.length
	return `Onboarding: ${count} step${count === 1 ? '' : 's'} left — ${remainingLabels.join(', ')}. Kody is the home your agents share, not a gateway. Details: ${baseUrl}/onboarding`
}

export const onboardingExplorePackagesLabel = 'Explore packages'

export function onboardingExplorePackagesHref() {
	return routes.community.href()
}

export function onboardingWizardStepByNumber(
	number: OnboardingWizardStepNumber,
) {
	const step = onboardingWizardSteps[number - 1]
	if (step?.number !== number) {
		throw new Error(`Unknown onboarding wizard step ${String(number)}`)
	}
	return step
}

export function onboardingWizardStepHref(
	number: OnboardingWizardStepNumber,
	search = '',
) {
	return `${onboardingWizardStepByNumber(number).path}${search}`
}

export function onboardingIndexRedirectHref(
	search = '',
	progress?: OnboardingWizardProgress,
) {
	const step = progress ? resumeOnboardingWizardStep(progress) : 1
	return onboardingWizardStepHref(step, search)
}

export function onboardingChecklistItemHref(
	id: OnboardingChecklistItemId,
	username: string,
): string {
	const item = onboardingChecklistItems.find((candidate) => candidate.id === id)
	if (!item) {
		throw new Error(`Unknown onboarding checklist item ${id}`)
	}
	if ('href' in item) return item.href
	if ('profile' in item) return routes.profile.href({ username })
	return onboardingWizardStepHref(item.wizardStep)
}

export function isOnboardingPagePath(pathname: string) {
	return (
		pathname === onboardingStepPaths.index ||
		pathname === onboardingStepPaths.step1 ||
		pathname === onboardingStepPaths.step2 ||
		pathname === onboardingStepPaths.step3 ||
		pathname.startsWith(`${onboardingStepPaths.step1}/`) ||
		pathname.startsWith(`${onboardingStepPaths.step2}/`) ||
		pathname.startsWith(`${onboardingStepPaths.step3}/`)
	)
}

function onboardingAgentPathSegment(agent: McpClientKind) {
	return agent === 'other' ? onboardingNotListedSegment : agent
}

function readOnboardingAgentSegment(segment: string): McpClientKind | null {
	if (segment === onboardingNotListedSegment) return 'other'
	return isMcpClientKind(segment) ? segment : null
}

export function onboardingAgentHref(agent: McpClientKind | null, search = '') {
	if (!agent) return `${routes.onboardingStep1.href()}${search}`
	return `${routes.onboardingStep1Agent.href({
		agent: onboardingAgentPathSegment(agent),
	})}${search}`
}

export function onboardingSecondAgentHref(
	agent: McpClientKind | null,
	search = '',
) {
	if (!agent) return `${routes.onboardingStep3.href()}${search}`
	return `${routes.onboardingStep3Agent.href({
		agent: onboardingAgentPathSegment(agent),
	})}${search}`
}

export function parseOnboardingPathname(
	pathname: string,
): OnboardingLocation | null {
	if (
		pathname === onboardingStepPaths.index ||
		pathname === onboardingStepPaths.step1
	) {
		return { step: 1, agent: null, valid: true }
	}
	if (pathname === onboardingStepPaths.step2) {
		return { step: 2, agent: null, valid: true }
	}
	if (pathname === onboardingStepPaths.step3) {
		return { step: 3, agent: null, valid: true }
	}
	const step1Prefix = `${onboardingStepPaths.step1}/`
	if (pathname.startsWith(step1Prefix)) {
		const segment = pathname.slice(step1Prefix.length)
		if (!segment || segment.includes('/')) {
			return { step: 1, agent: null, valid: false }
		}
		const agent = readOnboardingAgentSegment(segment)
		return { step: 1, agent, valid: agent != null }
	}
	const step2Prefix = `${onboardingStepPaths.step2}/`
	if (pathname.startsWith(step2Prefix)) {
		// Former service-picker URLs land on the rewritten Step 2.
		return { step: 2, agent: null, valid: false }
	}
	const step3Prefix = `${onboardingStepPaths.step3}/`
	if (pathname.startsWith(step3Prefix)) {
		const segment = pathname.slice(step3Prefix.length)
		if (!segment || segment.includes('/')) {
			return { step: 3, agent: null, valid: false }
		}
		const agent = readOnboardingAgentSegment(segment)
		return { step: 3, agent, valid: agent != null }
	}
	return null
}
