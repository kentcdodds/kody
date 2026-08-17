import { expect, test } from 'vitest'
import { buildCommunityPublicUrl } from './shared.ts'

test('community public URLs prefer the canonical user URL and fall back to the listing id', () => {
	expect(
		buildCommunityPublicUrl('https://example.com', {
			listingId: 'listing-1',
			name: '@kentcdodds/x',
			kodyId: 'x',
		}),
	).toBe('https://example.com/@kentcdodds/x')

	expect(
		buildCommunityPublicUrl('https://example.com', {
			listingId: 'listing-1',
			name: 'x',
			kodyId: 'x',
		}),
	).toBe('https://example.com/community/listing-1')

	expect(
		buildCommunityPublicUrl('https://example.com', {
			listingId: 'listing-1',
			name: '@kentcdodds/x',
		}),
	).toBe('https://example.com/community/listing-1')
})
