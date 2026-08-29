import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	firstWinAlignment,
	onboardingChecklistItemHref,
	onboardingChecklistItems,
	onboardingWizardStepByNumber,
	onboardingWizardStepHref,
	onboardingWizardSteps,
	readLegacyOnboardingStep,
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
			firstWin.includes(step.label) || firstWin.includes(`#${step.hash}`),
			`docs/guides/${firstWinAlignment.guideSlug}.md must name wizard step ${step.number} (${step.label} or #${step.hash}). Update that guide when onboarding-process.ts changes.`,
		).toBe(true)
	}

	expect(firstWin).toContain(`/guides/${firstWinAlignment.climaxGuideSlug}`)
	expect(firstWin).toContain(`/onboarding#${next.hash}`)
	expect(climax).toContain(next.label)
	expect(climax).toContain(`Step ${next.number}`)
	expect(climax).toContain(`#${prerequisite.hash}`)
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
		expect(onboardingChecklistItemHref(item.id, '/onboarding')).toBe(
			`/onboarding#${step.hash}`,
		)
	}
	expect(onboardingWizardStepHref('/onboarding', 2)).toBe(
		'/onboarding#connect-mcp',
	)
	expect(
		onboardingWizardStepHref('/onboarding', 3, '?agent=cursor&surface=desktop'),
	).toBe('/onboarding?agent=cursor&surface=desktop#first-build')
	expect(readLegacyOnboardingStep('first-win')).toBe(3)
	expect(readLegacyOnboardingStep('toString')).toBe(null)
})
