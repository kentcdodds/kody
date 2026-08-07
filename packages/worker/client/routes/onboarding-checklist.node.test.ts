import { expect, test } from 'vitest'
import { isOnboardingChecklistItemDone } from '#client/routes/onboarding-checklist.tsx'

test('isOnboardingChecklistItemDone reads derived checklist signals', () => {
	expect(isOnboardingChecklistItemDone(null, 'first-hello')).toBe(false)
	expect(
		isOnboardingChecklistItemDone(
			{
				dismissed: false,
				items: [
					{ id: 'first-hello', done: true },
					{ id: 'save-memory', done: false },
				],
			},
			'first-hello',
		),
	).toBe(true)
	expect(
		isOnboardingChecklistItemDone(
			{
				dismissed: false,
				items: [
					{ id: 'first-hello', done: true },
					{ id: 'save-memory', done: false },
				],
			},
			'save-memory',
		),
	).toBe(false)
})
