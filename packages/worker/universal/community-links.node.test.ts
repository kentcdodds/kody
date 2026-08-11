import { expect, test } from 'vitest'
import { getCommunityListingHref } from '#universal/community-links.ts'

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
