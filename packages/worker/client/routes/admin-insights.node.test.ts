import { expect, test } from 'vitest'
import { formatRunLogCompletenessWarning } from './admin-insights.tsx'

test('formatRunLogCompletenessWarning is hidden when fanout is complete', () => {
	expect(
		formatRunLogCompletenessWarning({
			usersAttempted: 0,
			usersLoaded: 0,
			complete: true,
		}),
	).toBeNull()
	expect(
		formatRunLogCompletenessWarning({
			usersAttempted: 4,
			usersLoaded: 4,
			complete: true,
		}),
	).toBeNull()
})

test('formatRunLogCompletenessWarning explains partial workflow and activation totals', () => {
	expect(
		formatRunLogCompletenessWarning({
			usersAttempted: 5,
			usersLoaded: 3,
			complete: false,
		}),
	).toBe(
		'Workflow and activation totals are partial — loaded RunLog snapshots for 3 of 5 users.',
	)
})
