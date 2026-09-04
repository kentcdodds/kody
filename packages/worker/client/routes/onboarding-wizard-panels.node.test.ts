import { css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	emptyOnboardingSessionMilestones,
	onboardingAccessPickerLede,
	onboardingAccessSelectedLede,
	onboardingCopyRemainingTasksLabel,
	onboardingExplorePackagesHref,
	onboardingRemainingMilestonesPrompt,
	onboardingUseKodyPromptForCustomName,
	onboardingConnectedPrompt,
	onboardingNotListedAnything,
	onboardingUnconnectedNotice,
	onboardingUseKodyPromptForService,
} from '#universal/onboarding-process.ts'
import { defaultKodyMcpUrl } from './onboarding-mcp-clients.ts'
import {
	renderAccessPanel,
	renderConnectAgentPanel,
} from './onboarding-wizard-panels.tsx'

const discoveryPrompt =
	"I'm deciding whether Kody (https://example.com) would be useful for me. Read https://example.com/guides/what-is-kody and then interview me to find out what Kody could do for me."

function connectPanel(selected: {
	agent: 'cursor' | null
	label: string | null
	loggedIn?: boolean
	hasMcpClient?: boolean
}) {
	return renderConnectAgentPanel({
		entrance: css({}),
		activeStep: 1,
		onSelectStep() {},
		loggedIn: selected.loggedIn ?? false,
		hasMcpClient: selected.hasMcpClient ?? false,
		selectedAgent: selected.agent,
		selectedAgentLabel: selected.label,
		agentChooser: null,
		mcpServerUrl: defaultKodyMcpUrl,
		mcpHighlights: {},
	})
}

function accessPanel(selected: {
	service: 'notion' | 'linear' | 'x' | 'google' | 'not-listed' | null
	loggedIn?: boolean
	hasMcpClient?: boolean
	selectedAgentLabel?: string | null
	customServiceName?: string
	discoveryPrompt?: string
	milestones?: typeof emptyOnboardingSessionMilestones
}) {
	return renderAccessPanel({
		entrance: css({}),
		activeStep: 2,
		onSelectStep() {},
		hasMcpClient: selected.hasMcpClient ?? false,
		discoveryPrompt: selected.discoveryPrompt ?? discoveryPrompt,
		milestones: selected.milestones ?? emptyOnboardingSessionMilestones,
		selectedService: selected.service,
		serviceChooser: null,
		selectedAgentLabel: selected.selectedAgentLabel ?? null,
		customServiceName: selected.customServiceName,
	})
}

test('step 1 title names the selected agent and offers a text change link', async () => {
	const picker = await renderToString(
		connectPanel({ agent: null, label: null }),
	)
	expect(picker).toContain('Connect your agent')
	expect(picker).toContain('data-testid="onboarding-agent-selection-meta"')
	expect(picker).not.toContain('data-testid="onboarding-agent-change"')
	expect(picker).not.toContain('data-testid="onboarding-agent-title-mark"')
	expect(picker).toContain('href="/onboarding/step-1/cursor"')
	expect(picker).not.toContain('surface=')

	const cursor = await renderToString(
		connectPanel({ agent: 'cursor', label: 'Cursor' }),
	)
	expect(cursor).toContain('Connect Cursor')
	expect(cursor).toContain('data-testid="onboarding-agent-title-mark"')
	expect(cursor).toContain('/images/icons/cursor.svg')
	expect(cursor).toContain('data-testid="onboarding-agent-change"')
	expect(cursor).toContain('href="/onboarding/step-1"')
	expect(cursor).toContain('Change selection')
	expect(cursor).toContain('data-testid="onboarding-agent-login"')
	expect(cursor).toContain('Log in to connect Cursor')
	expect(cursor).toContain('/login?redirectTo=')
	expect(cursor).toContain('step-1%2Fcursor')
	expect(cursor).not.toContain('Waiting for Cursor to connect')

	const signedIn = await renderToString(
		connectPanel({ agent: 'cursor', label: 'Cursor', loggedIn: true }),
	)
	expect(signedIn).toContain('Waiting for Cursor to connect')
	expect(signedIn).not.toContain('data-testid="onboarding-agent-login"')

	const connected = await renderToString(
		connectPanel({
			agent: 'cursor',
			label: 'Cursor',
			loggedIn: true,
			hasMcpClient: true,
		}),
	)
	expect(connected).toContain('Cursor is connected')
	expect(connected).not.toContain('data-testid="onboarding-agent-login"')
})

test('step 2 skip-unconnected shows the homepage discovery prompt', async () => {
	const picker = await renderToString(accessPanel({ service: null }))
	expect(picker).toContain('Give Kody access')
	expect(picker).toContain(onboardingAccessPickerLede)
	expect(picker).toContain(onboardingUnconnectedNotice)
	expect(picker).toContain(discoveryPrompt)
	expect(picker).toContain('Copy the discovery prompt')
	expect(picker).toContain('data-testid="onboarding-unconnected-prompt"')
	expect(picker).toContain('<pre')
	expect(picker).not.toContain('data-testid="onboarding-connected-prompt"')
	expect(picker).not.toContain('data-testid="onboarding-milestones"')
	expect(picker).not.toContain('data-testid="onboarding-service-picker"')
	expect(picker).not.toContain('href="/onboarding/step-2/notion"')
	expect(picker).not.toContain('href="/onboarding/step-2/not-listed"')
	expect(picker).not.toContain('x.com')
	expect(picker).not.toContain('Choose which service')
	expect(picker).not.toContain('set anything up yet')
	expect(picker).not.toContain('href="/onboarding/step-3"')
	expect(picker).not.toContain('data-testid="onboarding-mcp-notion-connect"')
	expect(picker).not.toContain('surface=')

	const selectedWhileUnconnected = await renderToString(
		accessPanel({ service: 'notion' }),
	)
	expect(selectedWhileUnconnected).toContain(onboardingUnconnectedNotice)
	expect(selectedWhileUnconnected).toContain(discoveryPrompt)
	expect(selectedWhileUnconnected).toContain('<pre')
	expect(selectedWhileUnconnected).not.toContain(
		'data-testid="onboarding-service-picker"',
	)
	expect(selectedWhileUnconnected).not.toContain(
		'data-testid="onboarding-connected-prompt"',
	)
	expect(selectedWhileUnconnected).not.toContain(
		'data-testid="onboarding-milestones"',
	)
})

test('step 2 connected index is picker plus Show more, without milestones', async () => {
	const connected = await renderToString(
		accessPanel({
			service: null,
			hasMcpClient: true,
			milestones: {
				...emptyOnboardingSessionMilestones,
				execute: true,
			},
		}),
	)
	expect(connected).toContain(onboardingAccessPickerLede)
	expect(connected).not.toContain(onboardingAccessSelectedLede(null))
	expect(connected).toContain('data-testid="onboarding-service-picker"')
	expect(connected).toContain('data-testid="onboarding-service-show-more"')
	expect(connected).toContain('Show more')
	expect(connected).toContain(onboardingNotListedAnything)
	expect(connected).toContain('href="/onboarding/step-2/notion"')
	expect(connected).toContain('href="/onboarding/step-2/linear"')
	expect(connected).toContain('href="/onboarding/step-2/github"')
	expect(connected).toContain('href="/onboarding/step-2/google"')
	expect(connected).toContain('href="/onboarding/step-2/x"')
	expect(connected).toContain('href="/onboarding/step-2/not-listed"')
	expect(connected).toContain('data-testid="onboarding-service-github"')
	expect(connected).toContain('data-testid="onboarding-service-google"')
	expect(connected).toContain('data-testid="onboarding-service-x"')
	expect(connected).toContain('data-testid="onboarding-service-not-listed"')
	expect(connected.indexOf('data-testid="onboarding-service-x"')).toBeLessThan(
		connected.indexOf('data-testid="onboarding-service-not-listed"'),
	)
	expect(
		connected.indexOf('data-testid="onboarding-service-show-more"'),
	).toBeLessThan(
		connected.indexOf('data-testid="onboarding-service-not-listed"'),
	)
	expect(connected).toContain('>x.com<')
	expect(connected).not.toContain('data-testid="onboarding-not-listed-github"')
	expect(connected).not.toContain(onboardingConnectedPrompt)
	expect(connected).not.toContain('data-testid="onboarding-connected-prompt"')
	expect(connected).not.toContain('data-testid="onboarding-milestones"')
	expect(connected).toContain('data-testid="onboarding-service-selection-meta"')
	expect(connected).not.toContain('data-testid="onboarding-service-change"')
	expect(connected).not.toContain('data-testid="onboarding-service-difficulty"')
	expect(connected).not.toContain('You can leave this page whenever you want.')
	expect(connected).not.toContain(onboardingUnconnectedNotice)
	expect(connected).not.toContain('data-testid="onboarding-unconnected-prompt"')
})

test('step 2 selected service is a prompt well and milestones, without the grid', async () => {
	const notion = await renderToString(
		accessPanel({
			service: 'notion',
			hasMcpClient: true,
			milestones: {
				...emptyOnboardingSessionMilestones,
				execute: true,
			},
		}),
	)
	expect(notion).toContain(onboardingAccessSelectedLede(null))
	expect(notion).not.toContain(onboardingAccessPickerLede)
	expect(notion).toContain(onboardingUseKodyPromptForService('notion'))
	expect(notion).toContain('data-testid="onboarding-connected-prompt"')
	expect(notion).toContain('Copy prompt')
	expect(notion).toContain('<pre')
	expect(notion).toContain('data-testid="onboarding-service-title-mark"')
	expect(notion).toContain('data-testid="onboarding-service-selection-meta"')
	expect(notion).toContain('data-testid="onboarding-service-change"')
	expect(notion).toContain('href="/onboarding/step-2"')
	expect(notion).toContain('Change selection')
	expect(notion).toContain('data-testid="onboarding-service-difficulty"')
	expect(notion).toContain('data-level="easy"')
	expect(notion).toContain('Easiest setup: easy')
	expect(notion.match(/<span[^>]*data-filled="true"/g)?.length).toBe(1)
	expect(notion.match(/<span[^>]*data-filled="false"/g)?.length).toBe(2)
	expect(notion).toContain('data-testid="onboarding-milestones-heading"')
	expect(notion).toContain('Here are the tasks for your agent.')
	expect(notion).toContain('data-testid="onboarding-milestones"')
	expect(notion).toContain('data-testid="onboarding-milestone-execute"')
	expect(notion).not.toContain(
		'data-testid="onboarding-milestone-execute-copy"',
	)
	expect(notion).toContain('data-testid="onboarding-milestone-access-copy"')
	expect(notion).toContain(
		'Copy prompt for Connect an integration or MCP server',
	)
	const accessCopy = notion.match(
		/<button[^>]*data-testid="onboarding-milestone-access-copy"[^>]*>[\s\S]*?<\/button>/,
	)?.[0]
	expect(accessCopy).toContain('Connect an integration or MCP server')
	expect(accessCopy?.match(/<button/g)?.length).toBe(1)
	expect(notion).toContain('data-complete="true"')
	expect(notion).toContain('Run your first execute')
	expect(notion).toContain('Connect an integration or MCP server')
	expect(notion).toContain('Create a secret')
	expect(notion).toContain('Send yourself an email')
	expect(notion).toContain('Receive an email')
	expect(notion).toContain('Set up a scheduled job')
	expect(notion).toContain('data-testid="onboarding-milestone-email-send"')
	expect(notion).toContain('data-testid="onboarding-milestone-email-receive"')
	expect(notion).toContain('data-testid="onboarding-milestone-job"')
	expect(notion).not.toContain('data-testid="onboarding-service-picker"')
	expect(notion).not.toContain('data-testid="onboarding-service-show-more"')
	expect(notion).not.toContain('href="/onboarding/step-2/linear"')
	expect(notion).not.toContain('href="/onboarding/step-2/stripe"')
	expect(notion).not.toContain('href="/onboarding/step-2/not-listed"')
	expect(notion).not.toContain('You can leave this page whenever you want.')
	expect(notion).not.toContain(onboardingUnconnectedNotice)

	const linear = await renderToString(
		accessPanel({ service: 'linear', hasMcpClient: true }),
	)
	expect(linear).toContain(onboardingUseKodyPromptForService('linear'))
	expect(linear).toContain('integrations.sh')
	expect(linear).toContain('<pre')
	expect(linear).not.toContain('data-testid="onboarding-service-picker"')
	expect(linear).not.toContain('href="/onboarding/step-2/notion"')

	const zoomish = await renderToString(
		accessPanel({ service: 'x', hasMcpClient: true }),
	)
	expect(zoomish).toContain('Help me use Kody with x.com.')
	expect(zoomish).toContain('https://integrations.sh/mcp')
	expect(zoomish).not.toContain('communityFork')
	expect(zoomish).not.toContain('@kody/integrations-sh')
	expect(zoomish).not.toContain('Help me use Kody with X.')
	expect(zoomish).toContain('data-testid="onboarding-service-difficulty"')
	expect(zoomish).toContain('data-level="hard"')
	expect(zoomish).toContain('Easiest setup: hard')

	const google = await renderToString(
		accessPanel({ service: 'google', hasMcpClient: true }),
	)
	expect(google).toContain('data-level="hard"')
	expect(google).toContain('Easiest setup: hard')
	expect(google.match(/<span[^>]*data-filled="true"/g)?.length).toBe(3)
	expect(google.match(/<span[^>]*data-filled="false"/g)?.length ?? 0).toBe(0)

	const notListed = await renderToString(
		accessPanel({ service: 'not-listed', hasMcpClient: true }),
	)
	expect(notListed).toContain(onboardingAccessSelectedLede(null))
	expect(notListed).not.toContain(onboardingAccessPickerLede)
	expect(notListed).toContain('data-testid="onboarding-service-custom-name"')
	expect(notListed).toContain('data-testid="onboarding-connected-prompt"')
	expect(notListed).toContain('Which service?')
	expect(notListed).toContain(onboardingUseKodyPromptForService('not-listed'))
	expect(notListed).toContain('this service')
	expect(notListed).toContain('integrations.sh')
	expect(notListed).toContain('data-testid="onboarding-milestones"')
	expect(notListed).toContain('data-testid="onboarding-service-change"')
	expect(notListed).not.toContain('data-testid="onboarding-service-difficulty"')
	expect(notListed).not.toContain('data-testid="onboarding-service-picker"')

	const named = await renderToString(
		accessPanel({
			service: 'notion',
			hasMcpClient: true,
			selectedAgentLabel: 'Cursor',
		}),
	)
	expect(named).toContain(onboardingAccessSelectedLede('Cursor'))
	expect(named).toContain(
		'Copy this prompt to Cursor, and it will help you get set up.',
	)
	expect(named).toContain('Here are the tasks for Cursor.')
	expect(named).not.toContain(onboardingAccessPickerLede)

	const pickerWithAgent = await renderToString(
		accessPanel({
			service: null,
			hasMcpClient: true,
			selectedAgentLabel: 'Cursor',
		}),
	)
	expect(pickerWithAgent).toContain(onboardingAccessPickerLede)
	expect(pickerWithAgent).not.toContain(onboardingAccessSelectedLede('Cursor'))
})

test('step 2 footer copies remaining milestone tasks, not the CopyCard', async () => {
	const picker = await renderToString(
		accessPanel({ service: null, hasMcpClient: true }),
	)
	expect(picker).toContain('data-testid="onboarding-wizard-explore-packages"')
	expect(picker).toContain(`href="${onboardingExplorePackagesHref()}"`)
	expect(picker).toContain('Explore packages')
	expect(picker).not.toContain('data-testid="onboarding-wizard-copy-prompt"')
	expect(picker).not.toContain('data-testid="onboarding-wizard-next"')

	const leftover = {
		...emptyOnboardingSessionMilestones,
		execute: true,
	}
	const leftoverPrompt = onboardingRemainingMilestonesPrompt(leftover, 'Cursor')
	expect(leftoverPrompt).toContain('these remaining steps:')
	const notion = await renderToString(
		accessPanel({
			service: 'notion',
			hasMcpClient: true,
			selectedAgentLabel: 'Cursor',
			milestones: leftover,
		}),
	)
	const notionCard = onboardingUseKodyPromptForService('notion')
	expect(notion).toContain(notionCard)
	expect(notion).toContain('data-testid="onboarding-wizard-copy-prompt"')
	expect(notion).toContain('data-copy-value="')
	expect(notion).toContain('finishing Kody onboarding')
	expect(notion).toContain('these remaining steps:')
	expect(notion).toContain(
		'Connect an integration or MCP server. Add an official MCP server',
	)
	expect(notion).not.toContain(`data-copy-value="${notionCard}"`)
	expect(notion).toContain(onboardingCopyRemainingTasksLabel)
	expect(notion).not.toContain('Copy prompt for Cursor')
	expect(notion).toContain(`href="${onboardingExplorePackagesHref()}"`)
	expect(notion).not.toContain('data-testid="onboarding-wizard-next"')
	expect(notion).toContain('data-status-slot')
	expect(notion).toContain('data-icon="clipboard"')
	expect(notion).toContain('data-testid="onboarding-milestone-execute-check"')
	expect(notion).toContain('data-testid="onboarding-milestone-access-copy"')

	const namedCustom = await renderToString(
		accessPanel({
			service: 'not-listed',
			hasMcpClient: true,
			customServiceName: 'Todoist',
			milestones: leftover,
		}),
	)
	expect(namedCustom).toContain('Help me use Kody with this service')
	expect(namedCustom).toContain('these remaining steps:')
	expect(namedCustom).toContain(onboardingCopyRemainingTasksLabel)
	expect(namedCustom).not.toContain(
		`data-copy-value="${onboardingUseKodyPromptForCustomName('Todoist')}"`,
	)

	const allDone = await renderToString(
		accessPanel({
			service: 'notion',
			hasMcpClient: true,
			milestones: {
				execute: true,
				access: true,
				secret: true,
				'email-send': true,
				'email-receive': true,
				job: true,
			},
		}),
	)
	expect(allDone).toContain('data-testid="onboarding-wizard-explore-packages"')
	expect(allDone).not.toContain('data-testid="onboarding-wizard-copy-prompt"')
	expect(allDone).not.toContain('data-testid="onboarding-wizard-next"')

	const unconnected = await renderToString(accessPanel({ service: null }))
	expect(unconnected).toContain(discoveryPrompt)
	expect(unconnected).toContain(
		'data-testid="onboarding-wizard-explore-packages"',
	)
	expect(unconnected).not.toContain(
		'data-testid="onboarding-wizard-copy-prompt"',
	)
	expect(unconnected).not.toContain('data-testid="onboarding-wizard-next"')

	const step1 = await renderToString(connectPanel({ agent: null, label: null }))
	expect(step1).toContain('data-testid="onboarding-wizard-next"')
	expect(step1).not.toMatch(
		/data-testid="onboarding-wizard-next"[^>]*\bdisabled\b/,
	)
	expect(step1).not.toContain(
		'data-testid="onboarding-wizard-explore-packages"',
	)
})
