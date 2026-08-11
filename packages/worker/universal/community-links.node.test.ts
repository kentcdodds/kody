import { expect, test } from 'vitest'
import { getCommunityListingHref } from '#universal/community-links.ts'

test('the canonical href comes from the owner, however the caller holds it', () => {
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
})

test('a listing without a resolvable owner or kody id keeps its working id link', () => {
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
