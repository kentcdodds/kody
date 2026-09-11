import { expect, test } from 'vitest'
import { listingNeedsRepublish } from './listing-needs-republish.ts'

test('listingNeedsRepublish is pin vs published commit, not timestamp order', () => {
	expect(
		listingNeedsRepublish({
			listingPinnedCommit: 'abc123',
			sourcePublishedCommit: 'abc123',
		}),
	).toBe(false)
	expect(
		listingNeedsRepublish({
			listingPinnedCommit: 'abc123',
			sourcePublishedCommit: 'def456',
		}),
	).toBe(true)
	expect(
		listingNeedsRepublish({
			listingPinnedCommit: '  abc123  ',
			sourcePublishedCommit: 'abc123',
		}),
	).toBe(false)
	expect(
		listingNeedsRepublish({
			listingPinnedCommit: null,
			sourcePublishedCommit: 'abc123',
		}),
	).toBe(false)
	expect(
		listingNeedsRepublish({
			listingPinnedCommit: 'abc123',
			sourcePublishedCommit: '',
		}),
	).toBe(false)
})
