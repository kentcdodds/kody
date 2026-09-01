import { expect, test } from 'vitest'
import { renderProfileContentHtml } from '#app/profile-content.tsx'
import {
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'

const profile = {
	username: 'kody',
	displayName: 'Kody',
	bio: null,
	avatarUrl: null,
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	publicPackageCount: 2,
	listingCount: 1,
} satisfies PublicCommunityProfile

const listedPackage = {
	name: '@kody/fathom-analytics',
	kodyId: 'fathom-analytics',
	description: 'Read Fathom Analytics site stats.',
	tags: ['fathom', 'analytics'],
	updatedAt: '2026-08-07T00:00:00.000Z',
	communityListingId: 'listing-1',
	communityListingKodyId: 'fathom-analytics',
	communityPublishedAt: '2026-07-28T00:00:00.000Z',
} satisfies PublicProfilePackageItem

const unpublishedPackage = {
	name: '@kody/notes',
	kodyId: 'notes',
	description: 'Private notes helper.',
	tags: [],
	updatedAt: '2026-07-01T00:00:00.000Z',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
} satisfies PublicProfilePackageItem

test('profile packages link listings, prefer listing kody ids, and separate published dates from local edits', async () => {
	const guestHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: null,
		isSelf: false,
	})

	expect(guestHtml).toContain('href="/@kody/fathom-analytics"')
	// Listed packages get one fork control; unpublished packages do not.
	expect(guestHtml.match(/aria-label="fork"/g)).toHaveLength(1)
	expect(guestHtml).toContain('notes')
	expect(guestHtml).toContain('href="/@kody/notes"')

	// Listed packages report the listing's published date, not the owner's
	// unpublished local edit, which is what made the activity feed look stale.
	expect(guestHtml).toContain('Published July 28, 2026')
	expect(guestHtml).not.toContain('August 7, 2026')
	expect(guestHtml).toContain('Edited July 1, 2026')
	expect(guestHtml).toContain('data-testid="profile-activity-hint"')

	// Editing `kody.id` updates the package immediately; the listing's id only
	// moves on republish, so until then the page lives at the listing's id.
	const driftedHtml = await renderProfileContentHtml({
		profile,
		packages: [
			{
				...listedPackage,
				kodyId: 'fathom',
				communityListingKodyId: 'fathom-analytics',
			},
		],
		activity: [],
		query: null,
		isSelf: false,
	})
	expect(driftedHtml).toContain('href="/@kody/fathom-analytics"')
	expect(driftedHtml).not.toContain('href="/@kody/fathom"')

	const guestEmptyHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		isSelf: false,
	})
	expect(guestEmptyHtml).toContain('No public packages yet.')
	expect(guestEmptyHtml).toMatch(/<p[^>]*data-testid="profile-username"/)

	const ownHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage],
		activity: [],
		query: null,
		isSelf: true,
	})

	expect(ownHtml).toContain('@kody')
	// Owners also see that the listing is behind their local edits.
	expect(ownHtml).toContain('edited August 7, 2026, not republished')

	const ownInventoryHtml = await renderProfileContentHtml({
		profile,
		packages: [
			{
				...unpublishedPackage,
				hidden: true,
				isPrivate: true,
			},
		],
		activity: [],
		query: null,
		isSelf: true,
	})
	expect(ownInventoryHtml).toContain('href="/@kody/notes"')
	expect(ownInventoryHtml).toContain('Hidden')
	expect(ownInventoryHtml).toContain('Private')
	expect(ownInventoryHtml).toContain('Not published')

	const ownEmptyHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		isSelf: true,
	})
	expect(ownEmptyHtml).toContain('No packages yet.')
	expect(ownEmptyHtml).not.toContain('No public packages yet.')
})
