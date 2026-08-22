import { expect, test } from 'vitest'
import {
	buildListingAheadPrompt,
	isCommunityListingAhead,
} from './community-listing-ahead.ts'

test('isCommunityListingAhead is true only when both commits exist and differ', () => {
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
})

test('buildListingAheadPrompt names the listing, fork, and absorb step', () => {
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

	expect(prompt).toContain('@kentcdodds/github')
	expect(prompt).toContain('listing-1')
	expect(prompt).toContain('/@kentcdodds/github')
	expect(prompt).toContain('/@kentcdodds/github/files')
	expect(prompt).toContain('package_id pkg-1')
	expect(prompt).toContain('source_id src-1')
	expect(prompt).toContain('commit-old')
	expect(prompt).toContain('commit-new')
	expect(prompt).toContain('community_fork_absorb')
	expect(prompt).toContain('community_get')
	expect(prompt).toContain('repo_publish_session')
})
