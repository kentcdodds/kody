/**
 * Onboarding wizard, derived checklist, and first-win alignment. Client UI,
 * MCP search notices, and `docs/guides/first-win.md` all read from here so a
 * wizard change fails the alignment check until the guide is updated.
 */

export const onboardingWizardSteps = [
	{ number: 1, hash: 'connect-agent', label: 'Connect your agent' },
	{ number: 2, hash: 'connect-mcp', label: 'Give Kody Access' },
	{ number: 3, hash: 'first-build', label: 'Try it, then persist' },
] as const

export type OnboardingWizardStepNumber =
	(typeof onboardingWizardSteps)[number]['number']

/**
 * Older hashes from the email/memory, example-fork, and OAuth-lead steps.
 * `#first-win` lands on the current climax (persist), not Give Kody Access.
 */
export const legacyOnboardingStepHashes: Record<
	string,
	OnboardingWizardStepNumber
> = {
	'first-win': 3,
	'quick-example': 3,
	'connect-services': 2,
	'starter-packages': 3,
}

export function readLegacyOnboardingStep(
	hash: string,
): OnboardingWizardStepNumber | null {
	if (!Object.hasOwn(legacyOnboardingStepHashes, hash)) return null
	return legacyOnboardingStepHashes[hash] ?? null
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
		wizardStep: 3,
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
 * and next-step hash here are what `onboarding-process.node.test.ts` requires
 * `docs/guides/first-win.md` to name.
 */
export const firstWinAlignment = {
	guideSlug: 'first-win',
	climaxGuideSlug: 'quick-example',
	prerequisiteWizardStep: 2,
	nextWizardStep: 3,
} as const

export function onboardingWizardStepByNumber(
	number: OnboardingWizardStepNumber,
) {
	const step = onboardingWizardSteps[number - 1]
	if (step?.number !== number) {
		throw new Error(`Unknown onboarding wizard step ${String(number)}`)
	}
	return step
}

export function onboardingChecklistItemHref(
	id: OnboardingChecklistItemId,
	onboardingPath: string,
): string {
	const item = onboardingChecklistItems.find((candidate) => candidate.id === id)
	if (!item) {
		throw new Error(`Unknown onboarding checklist item ${id}`)
	}
	if ('href' in item) return item.href
	const step = onboardingWizardStepByNumber(item.wizardStep)
	return `${onboardingPath}#${step.hash}`
}
