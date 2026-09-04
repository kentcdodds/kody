/**
 * Onboarding wizard, derived checklist, and first-win alignment. Client UI,
 * MCP search notices, and `docs/guides/first-win.md` all read from here so a
 * wizard change fails the alignment check until the guide is updated.
 */

import {
	type McpClientKind,
	isMcpClientKind,
} from '#universal/onboarding-mcp-clients.ts'
import {
	type OnboardingServiceChoice,
	isOnboardingServiceChoice,
	onboardingFeaturedMcpServerById,
	onboardingNotListedServiceId,
	onboardingServiceLabel,
} from '#universal/onboarding-mcp-chooser.ts'
import { routes } from '#universal/routes.ts'

export const onboardingStepPaths = {
	index: '/onboarding',
	step1: '/onboarding/step-1',
	step1Agent: '/onboarding/step-1/:agent',
	step2: '/onboarding/step-2',
	step2Service: '/onboarding/step-2/:service',
} as const

export const onboardingNotListedSegment = 'not-listed'

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
		label: 'Give Kody Access',
	},
] as const

export type OnboardingWizardStepNumber =
	(typeof onboardingWizardSteps)[number]['number']

export type OnboardingLocation = {
	step: OnboardingWizardStepNumber
	agent: McpClientKind | null
	service: OnboardingServiceChoice | null
	valid: boolean
}

export const onboardingChecklistItems = [
	{
		id: 'verify-email',
		label: 'Verify your email',
		searchLabel: 'verify your email',
		href: '/pending-verification',
	},
	{
		id: 'connect-agent',
		label: 'Connect your agent',
		searchLabel: 'connect your agent',
		wizardStep: 1,
	},
	{
		id: 'connect-integration',
		label: 'Give Kody Access',
		searchLabel: 'give Kody access',
		wizardStep: 2,
	},
	{
		id: 'install-starter',
		label: 'Persist your first package',
		searchLabel: 'persist your first package',
		href: '/account/packages',
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

export const onboardingChecklistSearchLabels = Object.fromEntries(
	onboardingChecklistItems.map((item) => [item.id, item.searchLabel]),
) as Record<OnboardingChecklistItemId, string>

/**
 * Optional email → reply → memories loop. Not a wizard step. The climax guide
 * and next-step path here are what `onboarding-process.node.test.ts` requires
 * `docs/guides/first-win.md` to name.
 */
export const firstWinAlignment = {
	guideSlug: 'first-win',
	climaxGuideSlug: 'quick-example',
	prerequisiteWizardStep: 1,
	nextWizardStep: 2,
} as const

export const onboardingUnconnectedNotice =
	'Your agent cannot do anything in Kody yet.'

/** Step 2 picker index (`/onboarding/step-2` with no service). */
export const onboardingAccessPickerLede =
	'Kody works best when you give it access to your stuff.'

/**
 * Step 2 selected-service lede. Uses the step-1 display name when we know
 * it; otherwise "your agent". Do not pass "Not listed" / "Other".
 */
export function onboardingAccessSelectedLede(agentLabel: string | null) {
	const name = agentLabel?.trim() ? agentLabel.trim() : 'your agent'
	return `Copy this prompt to ${name}, and it will help you get set up.`
}

export const onboardingConnectedPrompt = "I'm set up with Kody. Help me use it."

export const onboardingNotListedAnything =
	'You can integrate Kody with anything. Just ask your agent.'

export const onboardingSessionMilestones = [
	{
		id: 'execute',
		label: 'Run your first execute',
		how: 'Use execute for a small one-off so I can see it work.',
	},
	{
		id: 'access',
		label: 'Connect an integration or MCP server',
		how: 'Add an official MCP server or an integration I already use.',
	},
	{
		id: 'secret',
		label: 'Create a secret',
		how: 'Create a stored secret for a credential I already have. Never ask me to paste the secret value in chat.',
	},
	{
		id: 'email-send',
		label: 'Send yourself an email',
		how: 'Send me an email through Kody.',
	},
	{
		id: 'email-receive',
		label: 'Receive an email',
		how: 'Get a message into my Kody inbox so inbound mail is working.',
	},
	{
		id: 'job',
		label: 'Set up a scheduled job',
		how: 'Create a package-owned scheduled job I can keep.',
	},
] as const

export type OnboardingSessionMilestoneId =
	(typeof onboardingSessionMilestones)[number]['id']

export type OnboardingSessionMilestoneState = Record<
	OnboardingSessionMilestoneId,
	boolean
>

export const emptyOnboardingSessionMilestones = {
	execute: false,
	access: false,
	secret: false,
	'email-send': false,
	'email-receive': false,
	job: false,
} satisfies OnboardingSessionMilestoneState

export function onboardingSessionMilestonesComplete(
	milestones: OnboardingSessionMilestoneState,
) {
	return onboardingSessionMilestones.every((item) => milestones[item.id])
}

export function onboardingMilestonesHeading(agentLabel: string | null) {
	const name = agentLabel?.trim() ? agentLabel.trim() : 'your agent'
	return `Here are the tasks for ${name}.`
}

export function remainingOnboardingSessionMilestoneLabels(
	milestones: OnboardingSessionMilestoneState,
): Array<string> {
	return onboardingSessionMilestones
		.filter((item) => !milestones[item.id])
		.map((item) => item.label)
}

export function onboardingSessionMilestoneInstruction(
	id: OnboardingSessionMilestoneId,
): string {
	const item = onboardingSessionMilestones.find(
		(candidate) => candidate.id === id,
	)
	if (!item) {
		throw new Error(`Unknown onboarding session milestone ${id}`)
	}
	return `${item.label}. ${item.how}`
}

export function onboardingSessionMilestonePrompt(
	id: OnboardingSessionMilestoneId,
): string {
	return `I'm finishing Kody onboarding. Help me complete this remaining step: ${onboardingSessionMilestoneInstruction(id)}`
}

/**
 * One pasteable leftover-onboarding prompt for the step-2 footer. Reuses the
 * same per-milestone instruction text as a single clipboard copy. Returns
 * null when nothing remains.
 */
export function onboardingRemainingMilestonesPrompt(
	milestones: OnboardingSessionMilestoneState,
	agentLabel: string | null,
): string | null {
	const remaining = onboardingSessionMilestones.filter(
		(item) => !milestones[item.id],
	)
	if (remaining.length === 0) return null
	const name = agentLabel?.trim()
	const lead = name ? `${name}, I'm` : `I'm`
	if (remaining.length === 1) {
		const only = remaining[0]
		if (!only) return null
		return `${lead} finishing Kody onboarding. Help me complete this remaining step: ${onboardingSessionMilestoneInstruction(only.id)}`
	}
	const lines = remaining
		.map((item) => `- ${onboardingSessionMilestoneInstruction(item.id)}`)
		.join('\n')
	return `${lead} finishing Kody onboarding. Help me complete these remaining steps:\n${lines}`
}

export function formatOnboardingSearchNotice(
	remainingLabels: ReadonlyArray<string>,
	baseUrl: string,
): string | null {
	if (remainingLabels.length === 0) return null
	const count = remainingLabels.length
	return `Onboarding: ${count} step${count === 1 ? '' : 's'} left — ${remainingLabels.join(', ')}. Details and dismissal: ${baseUrl}/onboarding`
}

export const onboardingUseKodyPromptOauthPatFollowUp =
	'MCP is easier; OAuth or a PAT is more powerful. Ask whether I want a quick test or extra time for more control. If I want a package, communitySearch for a close public one to fork or adapt.'

/**
 * Points the copied first-build prompt at integrations.sh directly (site
 * or public MCP). Do not tell the agent to fork or install a package.
 */
export function onboardingIntegrationsShFollowUp(serviceLabel: string) {
	return `Ask integrations.sh what ${serviceLabel} needs: https://integrations.sh or MCP at https://integrations.sh/mcp.`
}

export const onboardingCustomServicePlaceholder = 'this service'

export function onboardingUseKodyPrompt(
	serviceLabel: string | null,
	options?: { hasOauthPatAlternative?: boolean },
) {
	if (!serviceLabel) return onboardingConnectedPrompt
	const base = `Help me use Kody with ${serviceLabel}.`
	const integrations = onboardingIntegrationsShFollowUp(serviceLabel)
	if (options?.hasOauthPatAlternative) {
		return `${base} ${onboardingUseKodyPromptOauthPatFollowUp} ${integrations}`
	}
	return `${base} ${integrations}`
}

export function onboardingUseKodyPromptForCustomName(name: string) {
	const label = name.trim() || onboardingCustomServicePlaceholder
	return onboardingUseKodyPrompt(label, { hasOauthPatAlternative: true })
}

export function onboardingUseKodyPromptForService(
	service: OnboardingServiceChoice | null,
) {
	if (!service) return onboardingConnectedPrompt
	if (service === onboardingNotListedServiceId) {
		return onboardingUseKodyPromptForCustomName('')
	}
	const server = onboardingFeaturedMcpServerById(service)
	return onboardingUseKodyPrompt(onboardingServiceLabel(service), {
		hasOauthPatAlternative: server?.hasOauthPatAlternative ?? false,
	})
}

/** Last-step footer primary. Not "Copy prompt" — that label is the CopyCard. */
export const onboardingCopyRemainingTasksLabel = 'Copy remaining tasks'

export const onboardingExplorePackagesLabel = 'Explore packages'

export function onboardingExplorePackagesHref() {
	return routes.community.href()
}

/**
 * Last-step footer copy payload: leftover session milestones, never the
 * service-setup CopyCard. Picker / unconnected / all-done → null.
 */
export function onboardingAccessFooterCopyValue(input: {
	hasMcpClient: boolean
	selectedService: OnboardingServiceChoice | null
	milestones: OnboardingSessionMilestoneState
	agentLabel: string | null
}): string | null {
	if (!input.hasMcpClient || !input.selectedService) return null
	return onboardingRemainingMilestonesPrompt(input.milestones, input.agentLabel)
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

export function onboardingIndexRedirectHref(search = '') {
	return `${routes.onboardingStep1.href()}${search}`
}

export function onboardingChecklistItemHref(
	id: OnboardingChecklistItemId,
	_onboardingPath?: string,
): string {
	const item = onboardingChecklistItems.find((candidate) => candidate.id === id)
	if (!item) {
		throw new Error(`Unknown onboarding checklist item ${id}`)
	}
	if ('href' in item) return item.href
	return onboardingWizardStepHref(item.wizardStep)
}

export function isOnboardingPagePath(pathname: string) {
	return (
		pathname === onboardingStepPaths.index ||
		pathname === onboardingStepPaths.step1 ||
		pathname === onboardingStepPaths.step2 ||
		pathname === '/onboarding/step-3' ||
		pathname.startsWith(`${onboardingStepPaths.step1}/`) ||
		pathname.startsWith(`${onboardingStepPaths.step2}/`) ||
		pathname.startsWith('/onboarding/step-3/')
	)
}

export function onboardingAgentPathSegment(agent: McpClientKind) {
	return agent === 'other' ? onboardingNotListedSegment : agent
}

export function readOnboardingAgentSegment(
	segment: string,
): McpClientKind | null {
	if (segment === onboardingNotListedSegment) return 'other'
	return isMcpClientKind(segment) ? segment : null
}

export function onboardingServicePathSegment(service: OnboardingServiceChoice) {
	return service
}

export function onboardingAgentHref(agent: McpClientKind | null, search = '') {
	if (!agent) return `${routes.onboardingStep1.href()}${search}`
	return `${routes.onboardingStep1Agent.href({
		agent: onboardingAgentPathSegment(agent),
	})}${search}`
}

export function onboardingServiceHref(
	service: OnboardingServiceChoice | null,
	search = '',
) {
	if (!service) return `${routes.onboardingStep2.href()}${search}`
	return `${routes.onboardingStep2Service.href({
		service: onboardingServicePathSegment(service),
	})}${search}`
}

export function parseOnboardingPathname(
	pathname: string,
): OnboardingLocation | null {
	if (
		pathname === onboardingStepPaths.index ||
		pathname === onboardingStepPaths.step1
	) {
		return { step: 1, agent: null, service: null, valid: true }
	}
	if (pathname === onboardingStepPaths.step2) {
		return { step: 2, agent: null, service: null, valid: true }
	}
	if (
		pathname === '/onboarding/step-3' ||
		pathname.startsWith('/onboarding/step-3/')
	) {
		return { step: 2, agent: null, service: null, valid: false }
	}
	const step1Prefix = `${onboardingStepPaths.step1}/`
	if (pathname.startsWith(step1Prefix)) {
		const segment = pathname.slice(step1Prefix.length)
		if (!segment || segment.includes('/')) {
			return { step: 1, agent: null, service: null, valid: false }
		}
		const agent = readOnboardingAgentSegment(segment)
		return { step: 1, agent, service: null, valid: agent != null }
	}
	const step2Prefix = `${onboardingStepPaths.step2}/`
	if (pathname.startsWith(step2Prefix)) {
		const segment = pathname.slice(step2Prefix.length)
		if (!segment || segment.includes('/')) {
			return { step: 2, agent: null, service: null, valid: false }
		}
		const service = isOnboardingServiceChoice(segment) ? segment : null
		return { step: 2, agent: null, service, valid: service != null }
	}
	return null
}
