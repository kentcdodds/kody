import { expect, test } from 'vitest'
import { renderProfileContentHtml } from '#app/profile-content.tsx'
import {
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#app/community-public-types.ts'

const profile = {
	username: 'kody',
	displayName: 'Kody',
	bio: null,
	avatarUrl: null,
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	followerCount: 0,
	followingCount: 0,
	publicPackageCount: 2,
	listingCount: 1,
} satisfies PublicCommunityProfile

const listedPackage = {
	name: '@kody/fathom-analytics',
	kodyId: 'fathom-analytics',
	description: 'Read Fathom Analytics site stats.',
	tags: ['fathom', 'analytics'],
	updatedAt: '2026-07-28T00:00:00.000Z',
	communityListingId: 'listing-1',
} satisfies PublicProfilePackageItem

const unpublishedPackage = {
	name: '@kody/notes',
	kodyId: 'notes',
	description: 'Private notes helper.',
	tags: [],
	updatedAt: '2026-07-01T00:00:00.000Z',
	communityListingId: null,
} satisfies PublicProfilePackageItem

test('profile packages link the listing name and fork via a single icon control', async () => {
	const html = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: null,
		isSelf: false,
	})

	expect(html).toContain('href="/community/listing-1"')
	expect(html.match(/fathom-analytics/g)).toHaveLength(1)
	expect(html).toContain('href="/community/listing-1#fork-title"')
	// Listed packages get one fork control; unpublished packages do not.
	expect(html.match(/aria-label="fork"/g)).toHaveLength(1)
	expect(html).toContain('notes')
	expect(html).not.toContain('href="/community/notes')
})
