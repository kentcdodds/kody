import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	firstWinAlignment,
	onboardingAccessFooterCopyValue,
	onboardingAccessPickerLede,
	onboardingAccessSelectedLede,
	onboardingCopyRemainingTasksLabel,
	onboardingExplorePackagesHref,
	onboardingRemainingMilestonesPrompt,
	onboardingSessionMilestoneInstruction,
	onboardingMilestonesHeading,
	onboardingSessionMilestonePrompt,
	formatOnboardingSearchNotice,
	remainingOnboardingSessionMilestoneLabels,
	onboardingAgentHref,
	onboardingChecklistItemHref,
	onboardingIndexRedirectHref,
	onboardingChecklistItems,
	onboardingServiceHref,
	onboardingWizardStepByNumber,
	onboardingWizardStepHref,
	emptyOnboardingSessionMilestones,
	onboardingConnectedPrompt,
	onboardingNotListedAnything,
	onboardingSessionMilestones,
	onboardingSessionMilestonesEqual,
	onboardingUnconnectedNotice,
	onboardingIntegrationsShFollowUp,
	onboardingUseKodyPrompt,
	onboardingUseKodyPromptForCustomName,
	onboardingUseKodyPromptForService,
	onboardingUseKodyPromptOauthPatFollowUp,
	onboardingWizardSteps,
	parseOnboardingPathname,
} from './onboarding-process.ts'

const guidesDirectory = join(import.meta.dirname, '../../../docs/guides')

function readGuide(slug: string) {
	return readFileSync(join(guidesDirectory, `${slug}.md`), 'utf8')
}

test('first-win and quick-example name the current onboarding wizard', () => {
	const firstWin = readGuide(firstWinAlignment.guideSlug)
	const climax = readGuide(firstWinAlignment.climaxGuideSlug)
	const prerequisite = onboardingWizardStepByNumber(
		firstWinAlignment.prerequisiteWizardStep,
	)
	const next = onboardingWizardStepByNumber(firstWinAlignment.nextWizardStep)

	for (const step of onboardingWizardSteps) {
		expect(
			firstWin.includes(step.label) || firstWin.includes(step.path),
			`docs/guides/${firstWinAlignment.guideSlug}.md must name wizard step ${step.number} (${step.label} or ${step.path}). Update that guide when onboarding-process.ts changes.`,
		).toBe(true)
	}

	expect(firstWin).toContain(`/guides/${firstWinAlignment.climaxGuideSlug}`)
	expect(firstWin).toContain(next.path)
	expect(climax).toContain(next.label)
	expect(climax).toContain(`Step ${next.number}`)
	expect(climax).toContain(prerequisite.path)
})

test('the derived checklist covers verify-email plus each wizard step', () => {
	expect(onboardingChecklistItems.map((item) => item.id)).toEqual([
		'verify-email',
		'connect-agent',
		'connect-integration',
		'install-starter',
	])
	expect(onboardingChecklistItemHref('verify-email', '/onboarding')).toBe(
		'/pending-verification',
	)
	for (const step of onboardingWizardSteps) {
		const item = onboardingChecklistItems.find(
			(candidate) =>
				'wizardStep' in candidate && candidate.wizardStep === step.number,
		)
		if (!item) {
			throw new Error(`wizard step ${step.number} needs a checklist item`)
		}
		expect(onboardingChecklistItemHref(item.id)).toBe(step.path)
	}
	expect(onboardingIndexRedirectHref()).toBe('/onboarding/step-1')
	expect(onboardingIndexRedirectHref('?redirectTo=%2F')).toBe(
		'/onboarding/step-1?redirectTo=%2F',
	)
	expect(onboardingChecklistItemHref('install-starter')).toBe(
		'/onboarding/step-3',
	)
	expect(onboardingWizardStepHref(2)).toBe('/onboarding/step-2')
	expect(onboardingUnconnectedNotice).toBe(
		'Your agent cannot do anything in Kody yet.',
	)
	expect(onboardingNotListedAnything).toBe(
		'You can integrate Kody with anything. Just ask your agent.',
	)
	expect(onboardingConnectedPrompt).toBe(
		"I'm set up with Kody. Help me use it.",
	)
	expect(onboardingUseKodyPrompt(null)).toBe(onboardingConnectedPrompt)
	expect(onboardingUseKodyPrompt('Notion')).toBe(
		`Help me use Kody with Notion. ${onboardingIntegrationsShFollowUp('Notion')}`,
	)
	expect(onboardingUseKodyPromptForService('canva')).toBe(
		`Help me use Kody with Canva. ${onboardingIntegrationsShFollowUp('Canva')}`,
	)
	expect(onboardingUseKodyPromptForService('github')).toBe(
		`Help me use Kody with GitHub. ${onboardingUseKodyPromptOauthPatFollowUp} ${onboardingIntegrationsShFollowUp('GitHub')}`,
	)
	expect(onboardingUseKodyPromptForService('github')).toContain(
		'communitySearch',
	)
	expect(onboardingUseKodyPromptForService('x')).toContain('x.com')
	expect(onboardingUseKodyPromptForService('x')).not.toContain(
		'Help me use Kody with X.',
	)
	expect(onboardingUseKodyPromptForCustomName('Todoist')).toContain('Todoist')
	expect(onboardingUseKodyPromptForCustomName('Todoist')).toContain(
		'integrations.sh',
	)
	expect(onboardingUseKodyPromptForCustomName('')).toContain('this service')
	expect(onboardingIntegrationsShFollowUp('Zoom')).toContain(
		'https://integrations.sh/mcp',
	)
	expect(onboardingIntegrationsShFollowUp('Zoom')).not.toContain(
		'communityFork',
	)
	expect(onboardingIntegrationsShFollowUp('Zoom')).not.toContain(
		'@kody/integrations-sh',
	)
	expect(onboardingUseKodyPromptForService(null)).toBe(
		onboardingConnectedPrompt,
	)
	expect(onboardingSessionMilestones.map((item) => item.id)).toEqual([
		'execute',
		'access',
		'secret',
		'email-send',
		'email-receive',
		'job',
	])
	expect(onboardingSessionMilestones.map((item) => item.label)).toEqual([
		'Run your first execute',
		'Connect an integration or MCP server',
		'Create a secret',
		'Send yourself an email',
		'Receive an email',
		'Set up a scheduled job',
	])
	expect(onboardingAgentHref('cursor')).toBe('/onboarding/step-1/cursor')
	expect(onboardingAgentHref('other')).toBe('/onboarding/step-1/not-listed')
	expect(onboardingAgentHref('cursor', '?redirectTo=%2F')).toBe(
		'/onboarding/step-1/cursor?redirectTo=%2F',
	)
	expect(onboardingAgentHref(null, '?redirectTo=%2F')).toBe(
		'/onboarding/step-1?redirectTo=%2F',
	)
	expect(onboardingServiceHref('notion')).toBe('/onboarding/step-2/notion')
	expect(onboardingServiceHref('not-listed')).toBe(
		'/onboarding/step-2/not-listed',
	)
	expect(onboardingServiceHref('x')).toBe('/onboarding/step-2/x')
	expect(onboardingServiceHref('notion', '?redirectTo=%2F')).toBe(
		'/onboarding/step-2/notion?redirectTo=%2F',
	)
	expect(onboardingServiceHref(null, '?redirectTo=%2F')).toBe(
		'/onboarding/step-2?redirectTo=%2F',
	)
	expect(parseOnboardingPathname('/onboarding/step-2/not-listed')).toEqual({
		step: 2,
		agent: null,
		service: 'not-listed',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-2/x')).toEqual({
		step: 2,
		agent: null,
		service: 'x',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding')).toEqual({
		step: 1,
		agent: null,
		service: null,
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-1/cursor')).toEqual({
		step: 1,
		agent: 'cursor',
		service: null,
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-1/not-listed')).toEqual({
		step: 1,
		agent: 'other',
		service: null,
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-1/nope')?.valid).toBe(false)
	expect(parseOnboardingPathname('/onboarding/step-2/canva')).toEqual({
		step: 2,
		agent: null,
		service: 'canva',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-2/github')).toEqual({
		step: 2,
		agent: null,
		service: 'github',
		valid: true,
	})
	expect(parseOnboardingPathname('/account')).toBeNull()
	expect(parseOnboardingPathname('/onboarding/step-3')?.valid).toBe(false)
	expect(onboardingWizardSteps.map((step) => step.path)).toEqual([
		'/onboarding/step-1',
		'/onboarding/step-2',
	])
	for (const step of onboardingWizardSteps) {
		expect(onboardingWizardStepHref(step.number)).not.toContain('#')
		expect(onboardingWizardStepHref(step.number)).not.toContain('surface=')
	}
	expect(onboardingAgentHref('cursor')).not.toContain('#')
	expect(onboardingServiceHref('notion')).not.toContain('#')
})

test('last-step footer copies remaining milestone tasks, not the service CopyCard', () => {
	expect(onboardingCopyRemainingTasksLabel).toBe('Copy remaining tasks')
	expect(onboardingExplorePackagesHref()).toBe('/community')
	const leftover = {
		...emptyOnboardingSessionMilestones,
		execute: true,
	}
	const composed = onboardingRemainingMilestonesPrompt(leftover, 'Cursor')
	expect(composed).toContain("Cursor, I'm finishing Kody onboarding.")
	expect(composed).toContain('these remaining steps:')
	expect(composed).toContain(
		`- ${onboardingSessionMilestoneInstruction('access')}`,
	)
	expect(composed).toContain(
		`- ${onboardingSessionMilestoneInstruction('job')}`,
	)
	expect(composed).not.toContain(
		onboardingSessionMilestoneInstruction('execute'),
	)
	expect(composed).not.toContain(onboardingUseKodyPromptForService('notion'))
	expect(
		onboardingRemainingMilestonesPrompt(
			{
				execute: true,
				access: true,
				secret: true,
				'email-send': true,
				'email-receive': true,
				job: true,
			},
			'Cursor',
		),
	).toBeNull()
	expect(
		onboardingRemainingMilestonesPrompt(
			{
				...emptyOnboardingSessionMilestones,
				execute: true,
				access: true,
				secret: true,
				'email-send': true,
				'email-receive': true,
			},
			null,
		),
	).toBe(onboardingSessionMilestonePrompt('job'))
	expect(
		onboardingAccessFooterCopyValue({
			hasMcpClient: true,
			selectedService: null,
			milestones: leftover,
			agentLabel: 'Cursor',
		}),
	).toBeNull()
	expect(
		onboardingAccessFooterCopyValue({
			hasMcpClient: true,
			selectedService: 'notion',
			milestones: leftover,
			agentLabel: 'Cursor',
		}),
	).toBe(composed)
	expect(
		onboardingAccessFooterCopyValue({
			hasMcpClient: true,
			selectedService: 'notion',
			milestones: {
				execute: true,
				access: true,
				secret: true,
				'email-send': true,
				'email-receive': true,
				job: true,
			},
			agentLabel: 'Cursor',
		}),
	).toBeNull()
	expect(
		onboardingAccessFooterCopyValue({
			hasMcpClient: false,
			selectedService: 'notion',
			milestones: leftover,
			agentLabel: null,
		}),
	).toBeNull()
})

test('step 2 selected lede names the connected agent when we know it', () => {
	expect(onboardingAccessPickerLede).toBe(
		'Kody works best when you give it access to your stuff.',
	)
	expect(onboardingAccessSelectedLede(null)).toBe(
		'Copy this prompt to your agent, and it will help you get set up.',
	)
	expect(onboardingAccessSelectedLede('')).toBe(
		'Copy this prompt to your agent, and it will help you get set up.',
	)
	expect(onboardingAccessSelectedLede('Cursor')).toBe(
		'Copy this prompt to Cursor, and it will help you get set up.',
	)
	expect(onboardingAccessSelectedLede('ChatGPT.com')).toBe(
		'Copy this prompt to ChatGPT.com, and it will help you get set up.',
	)
	expect(onboardingAccessSelectedLede('Claude Desktop')).toBe(
		'Copy this prompt to Claude Desktop, and it will help you get set up.',
	)
})

test('session milestone copy and search notice share leftover task labels', () => {
	expect(onboardingMilestonesHeading(null)).toBe(
		'Here are the tasks for your agent.',
	)
	expect(onboardingMilestonesHeading('Cursor')).toBe(
		'Here are the tasks for Cursor.',
	)
	expect(onboardingSessionMilestonePrompt('execute')).toContain(
		'Run your first execute',
	)
	expect(onboardingSessionMilestonePrompt('access')).toContain(
		'Connect an integration or MCP server',
	)
	expect(onboardingSessionMilestonePrompt('secret')).toContain(
		'Create a secret',
	)
	expect(onboardingSessionMilestonePrompt('email-send')).toContain(
		'Send yourself an email',
	)
	expect(onboardingSessionMilestonePrompt('email-receive')).toContain(
		'Receive an email',
	)
	expect(onboardingSessionMilestonePrompt('job')).toContain(
		'Set up a scheduled job',
	)
	expect(
		remainingOnboardingSessionMilestoneLabels({
			...emptyOnboardingSessionMilestones,
			execute: true,
			access: true,
		}),
	).toEqual([
		'Create a secret',
		'Send yourself an email',
		'Receive an email',
		'Set up a scheduled job',
	])
	expect(
		onboardingSessionMilestonesEqual(
			emptyOnboardingSessionMilestones,
			emptyOnboardingSessionMilestones,
		),
	).toBe(true)
	expect(
		onboardingSessionMilestonesEqual(emptyOnboardingSessionMilestones, {
			...emptyOnboardingSessionMilestones,
			execute: true,
		}),
	).toBe(false)
	expect(
		onboardingSessionMilestonesEqual(
			{ ...emptyOnboardingSessionMilestones, execute: true, secret: true },
			{ ...emptyOnboardingSessionMilestones, execute: true, secret: true },
		),
	).toBe(true)
	expect(
		onboardingSessionMilestonesEqual(emptyOnboardingSessionMilestones, {
			...emptyOnboardingSessionMilestones,
			'email-send': true,
		}),
	).toBe(false)
	expect(
		onboardingSessionMilestonesEqual(emptyOnboardingSessionMilestones, {
			...emptyOnboardingSessionMilestones,
			'email-receive': true,
		}),
	).toBe(false)
	expect(
		onboardingSessionMilestonesEqual(emptyOnboardingSessionMilestones, {
			...emptyOnboardingSessionMilestones,
			job: true,
		}),
	).toBe(false)
	expect(
		formatOnboardingSearchNotice(
			['Run your first execute', 'Create a secret'],
			'https://kody.example',
		),
	).toBe(
		'Onboarding: 2 steps left — Run your first execute, Create a secret. Details and dismissal: https://kody.example/onboarding',
	)
	expect(formatOnboardingSearchNotice([], 'https://kody.example')).toBeNull()
})
