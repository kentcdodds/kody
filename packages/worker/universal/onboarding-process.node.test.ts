import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	formatOnboardingSearchNotice,
	onboardingAccessSelectedLede,
	onboardingAgentHref,
	onboardingChecklistItemHref,
	onboardingChecklistItems,
	onboardingExplorePackagesHref,
	onboardingGuideEntity,
	onboardingGuideFetchHint,
	onboardingIndexRedirectHref,
	onboardingPortabilityProofPrompt,
	onboardingSecondAgentHref,
	onboardingTeachConcepts,
	onboardingTeachPrompt,
	onboardingWizardStepHref,
	onboardingWizardSteps,
	parseOnboardingPathname,
	remainingOnboardingWizardLabels,
} from './onboarding-process.ts'

const guidesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../docs/guides',
)

test('the derived checklist covers verify-email plus each wizard step', () => {
	expect(onboardingChecklistItems.map((item) => item.id)).toEqual([
		'verify-email',
		'connect-agent',
		'give-access',
		'connect-second-agent',
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
	expect(onboardingWizardStepHref(3)).toBe('/onboarding/step-3')
	expect(onboardingAgentHref('cursor')).toBe('/onboarding/step-1/cursor')
	expect(onboardingAgentHref('other')).toBe('/onboarding/step-1/not-listed')
	expect(onboardingAgentHref('cursor', '?redirectTo=%2F')).toBe(
		'/onboarding/step-1/cursor?redirectTo=%2F',
	)
	expect(onboardingAgentHref(null, '?redirectTo=%2F')).toBe(
		'/onboarding/step-1?redirectTo=%2F',
	)
	expect(onboardingSecondAgentHref('claude-code')).toBe(
		'/onboarding/step-3/claude-code',
	)
	expect(onboardingSecondAgentHref('other')).toBe(
		'/onboarding/step-3/not-listed',
	)
	expect(onboardingSecondAgentHref(null, '?redirectTo=%2F')).toBe(
		'/onboarding/step-3?redirectTo=%2F',
	)
	expect(parseOnboardingPathname('/onboarding')).toEqual({
		step: 1,
		agent: null,
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-1/cursor')).toEqual({
		step: 1,
		agent: 'cursor',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-1/not-listed')).toEqual({
		step: 1,
		agent: 'other',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-1/nope')?.valid).toBe(false)
	expect(parseOnboardingPathname('/onboarding/step-2')).toEqual({
		step: 2,
		agent: null,
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-2/notion')).toEqual({
		step: 2,
		agent: null,
		valid: false,
	})
	expect(parseOnboardingPathname('/onboarding/step-3')).toEqual({
		step: 3,
		agent: null,
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-3/claude-code')).toEqual({
		step: 3,
		agent: 'claude-code',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-3/not-listed')).toEqual({
		step: 3,
		agent: 'other',
		valid: true,
	})
	expect(parseOnboardingPathname('/onboarding/step-3/nope')?.valid).toBe(false)
	expect(parseOnboardingPathname('/account')).toBeNull()
	expect(onboardingWizardSteps.map((step) => step.path)).toEqual([
		'/onboarding/step-1',
		'/onboarding/step-2',
		'/onboarding/step-3',
	])
	expect(onboardingExplorePackagesHref()).toBe('/community')
})

test('step 2 teach prompts stay brief and point at the onboarding guide', () => {
	expect(onboardingAccessSelectedLede(null)).toContain('your agent')
	expect(onboardingAccessSelectedLede('Cursor')).toContain('Cursor')
	expect(onboardingAccessSelectedLede('Cursor')).not.toContain('your agent')
	expect(onboardingTeachConcepts.map((item) => item.id)).toEqual([
		'home-and-memory',
		'execute',
		'packages',
		'durable-surfaces',
	])
	for (const item of onboardingTeachConcepts) {
		expect(onboardingTeachPrompt(item.id).length).toBeLessThan(700)
		expect(onboardingTeachPrompt(item.id)).toContain(onboardingGuideFetchHint)
		expect(onboardingTeachPrompt(item.id)).toContain(onboardingGuideEntity)
	}
	expect(onboardingPortabilityProofPrompt).toContain(onboardingGuideEntity)
	expect(onboardingPortabilityProofPrompt.length).toBeLessThan(400)
})

test('search leftover notice lists remaining wizard steps, not a quest', () => {
	expect(
		remainingOnboardingWizardLabels({
			hasMcpClient: true,
			hasAccessWin: false,
			hasSecondMcpClient: false,
		}),
	).toEqual(['Give Kody access', 'Connect a second agent'])
	expect(
		remainingOnboardingWizardLabels({
			hasMcpClient: true,
			hasAccessWin: true,
			hasSecondMcpClient: true,
		}),
	).toEqual([])
	const notice = formatOnboardingSearchNotice(
		['Give Kody access', 'Connect a second agent'],
		'https://kody.example',
	)
	expect(notice).toContain('2 steps left')
	expect(notice).toContain('Give Kody access')
	expect(notice).toContain('Connect a second agent')
	expect(notice).toContain('https://kody.example/onboarding')
	expect(formatOnboardingSearchNotice([], 'https://kody.example')).toBeNull()
})

test('first-win and quick-example name the current wizard steps', () => {
	const firstWin = readFileSync(join(guidesDir, 'first-win.md'), 'utf8')
	const quickExample = readFileSync(join(guidesDir, 'quick-example.md'), 'utf8')
	for (const step of onboardingWizardSteps) {
		expect(firstWin.includes(step.label) || firstWin.includes(step.path)).toBe(
			true,
		)
	}
	const giveAccess = onboardingWizardSteps.find((step) => step.number === 2)
	const connectAgent = onboardingWizardSteps.find((step) => step.number === 1)
	if (!giveAccess || !connectAgent) {
		throw new Error('wizard steps 1 and 2 are required')
	}
	expect(quickExample).toContain(giveAccess.label)
	expect(quickExample).toContain(connectAgent.path)
})
