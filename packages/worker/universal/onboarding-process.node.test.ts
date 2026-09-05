import { expect, test } from 'vitest'
import {
	onboardingAccessFooterCopyValue,
	onboardingAccessSelectedLede,
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
	onboardingWizardStepHref,
	emptyOnboardingSessionMilestones,
	onboardingSessionMilestonesEqual,
	onboardingIntegrationsShFollowUp,
	onboardingUseKodyPromptForCustomName,
	onboardingUseKodyPromptForService,
	onboardingWizardSteps,
	parseOnboardingPathname,
} from './onboarding-process.ts'

test('the derived checklist covers verify-email plus each wizard step', () => {
	expect(onboardingChecklistItems.map((item) => item.id)).toEqual([
		'verify-email',
		'connect-agent',
		'connect-integration',
		'install-starter',
	])
	expect(onboardingChecklistItemHref('verify-email', 'kentcdodds')).toBe(
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
		expect(onboardingChecklistItemHref(item.id, 'kentcdodds')).toBe(step.path)
	}
	expect(onboardingIndexRedirectHref()).toBe('/onboarding/step-1')
	expect(onboardingIndexRedirectHref('?redirectTo=%2F')).toBe(
		'/onboarding/step-1?redirectTo=%2F',
	)
	expect(onboardingChecklistItemHref('install-starter', 'kentcdodds')).toBe(
		'/@kentcdodds',
	)
	expect(onboardingWizardStepHref(2)).toBe('/onboarding/step-2')
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
})

test('last-step footer copies remaining milestone tasks, not the service CopyCard', () => {
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
	expect(onboardingAccessSelectedLede(null)).toContain('your agent')
	expect(onboardingAccessSelectedLede('')).toContain('your agent')
	expect(onboardingAccessSelectedLede('Cursor')).toContain('Cursor')
	expect(onboardingAccessSelectedLede('Cursor')).not.toContain('your agent')
})

test('session milestone copy and search notice share leftover task labels', () => {
	expect(onboardingMilestonesHeading(null)).toContain('your agent')
	expect(onboardingMilestonesHeading('Cursor')).toContain('Cursor')
	expect(onboardingMilestonesHeading('Cursor')).not.toContain('your agent')
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
	const notice = formatOnboardingSearchNotice(
		['Run your first execute', 'Create a secret'],
		'https://kody.example',
	)
	expect(notice).toContain('2 steps left')
	expect(notice).toContain('Run your first execute')
	expect(notice).toContain('Create a secret')
	expect(notice).toContain('https://kody.example/onboarding')
	expect(formatOnboardingSearchNotice([], 'https://kody.example')).toBeNull()
})
