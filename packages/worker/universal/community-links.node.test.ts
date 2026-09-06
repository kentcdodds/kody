import { expect, test } from 'vitest'
import {
	getCommunityListingHref,
	getCommunityPackageHrefFromName,
	isOfficialCommunityListing,
} from '#universal/community-links.ts'

test('community listing hrefs prefer the canonical pair and fall back to the id URL', () => {
	expect(
		getCommunityListingHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'devin',
		}),
	).toBe('/@kentcdodds/devin')

	expect(
		getCommunityListingHref({
			listingId: 'listing-1',
			listingName: '@kentcdodds/devin',
			kodyId: 'devin',
		}),
	).toBe('/@kentcdodds/devin')

	// Names are validated as scoped, so these are the defensive paths -- and a
	// dead `/@unknown/...` link would be worse than the id URL it replaced.
	expect(
		getCommunityListingHref({ listingId: 'listing-1', listingName: 'devin' }),
	).toBe('/community/listing-1')

	expect(
		getCommunityListingHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: null,
		}),
	).toBe('/community/listing-1')
})

test('official listings are the first-party @kody scope', () => {
	expect(isOfficialCommunityListing({ name: '@kody/notion-mcp' })).toBe(true)
	expect(isOfficialCommunityListing({ ownerUsername: 'kody' })).toBe(true)
	expect(isOfficialCommunityListing({ ownerUsername: 'Kody' })).toBe(true)
	expect(
		isOfficialCommunityListing({
			name: '@kentcdodds/github-triage',
			ownerUsername: 'kentcdodds',
		}),
	).toBe(false)
	expect(isOfficialCommunityListing({ name: 'unscoped' })).toBe(false)
	expect(getCommunityPackageHrefFromName('@jane/hn-pulse')).toBe(
		'/@jane/hn-pulse',
	)
	expect(getCommunityPackageHrefFromName('unscoped')).toBeNull()
})
