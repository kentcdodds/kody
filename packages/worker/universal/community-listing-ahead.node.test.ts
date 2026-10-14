import { expect, test } from 'vitest'
import {
	buildForkListingDiffHref,
	buildListingAheadPrompt,
	classifyForkListingRelation,
	readListingAheadFlag,
} from './community-listing-ahead.ts'

test('fork/listing relation is synced, ahead, or proven outdated', () => {
	expect(
		classifyForkListingRelation({
			originCommit: 'commit-same',
			listingPinnedCommit: 'commit-same',
		}),
	).toBe('synced')

	expect(
		classifyForkListingRelation({
			originCommit: 'commit-tip',
			listingPinnedCommit: 'commit-pin',
			listingPinIsAncestorOfForkTip: true,
		}),
	).toBe('ahead')

	expect(
		classifyForkListingRelation({
			originCommit: 'commit-old',
			listingPinnedCommit: 'commit-new',
			listingPinIsAncestorOfForkTip: false,
		}),
	).toBe('outdated')

	expect(
		classifyForkListingRelation({
			originCommit: 'commit-old',
			listingPinnedCommit: 'commit-new',
		}),
	).toBe('ahead')

	expect(
		classifyForkListingRelation({
			originCommit: 'commit-old',
			listingPinnedCommit: null,
		}),
	).toBe(null)
	expect(
		classifyForkListingRelation({
			originCommit: null,
			listingPinnedCommit: 'commit-new',
		}),
	).toBe(null)
	expect(
		classifyForkListingRelation({
			originCommit: '',
			listingPinnedCommit: 'commit-new',
		}),
	).toBe(null)
	expect(
		classifyForkListingRelation({
			originCommit: '   ',
			listingPinnedCommit: 'commit-new',
		}),
	).toBe(null)

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
	expect(prompt).toContain('repoPublishSession')
	expect(prompt).toContain('absorbed_upstream_commit')
	expect(prompt).toContain('communityGet')
	expect(prompt).toContain('/@kentcdodds/github/tree/commit-new')

	expect(
		buildForkListingDiffHref({
			listingId: 'listing-1',
			listingName: '@kentcdodds/github',
			listingKodyId: 'github',
			listingPinnedCommit: 'commit-new',
		}),
	).toBe('/@kentcdodds/github/tree/commit-new')
})
