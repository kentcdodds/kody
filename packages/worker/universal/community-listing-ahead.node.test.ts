import { expect, test } from 'vitest'
import {
	buildListingAheadPrompt,
	isCommunityListingAhead,
	readListingAheadFlag,
} from './community-listing-ahead.ts'

test('listing-ahead helpers gate on commit mismatch and expose absorb contracts', () => {
	expect(
		isCommunityListingAhead({
			originCommit: 'commit-old',
			listingPinnedCommit: 'commit-new',
		}),
	).toBe(true)
	expect(
		isCommunityListingAhead({
			originCommit: 'commit-same',
			listingPinnedCommit: 'commit-same',
		}),
	).toBe(false)
	expect(
		isCommunityListingAhead({
			originCommit: 'commit-old',
			listingPinnedCommit: null,
		}),
	).toBe(false)
	expect(
		isCommunityListingAhead({
			originCommit: null,
			listingPinnedCommit: 'commit-new',
		}),
	).toBe(false)

	expect(readListingAheadFlag({ listingAhead: true })).toBe(true)
	expect(readListingAheadFlag({ listingAhead: false })).toBe(false)
	expect(readListingAheadFlag({ listingAhead: null })).toBe(null)
	expect(readListingAheadFlag({})).toBe(null)
	expect(readListingAheadFlag(null)).toBe(null)

	const prompt = buildListingAheadPrompt({
		listingName: '@kentcdodds/github',
		listingId: 'listing-1',
		listingKodyId: 'github',
		packageName: '@me/github',
		packageId: 'pkg-1',
		sourceId: 'src-1',
		originCommit: 'commit-old',
		listingPinnedCommit: 'commit-new',
	})
	expect(prompt).toContain('listing-1')
	expect(prompt).toContain('package_id pkg-1')
	expect(prompt).toContain('source_id src-1')
	expect(prompt).toContain('community_fork_absorb')
	expect(prompt).toContain('community_get')
	expect(prompt).toContain('repo_publish_session')
})
