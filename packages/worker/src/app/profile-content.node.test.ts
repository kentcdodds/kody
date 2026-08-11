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
	updatedAt: '2026-08-07T00:00:00.000Z',
	communityListingId: 'listing-1',
	communityPublishedAt: '2026-07-28T00:00:00.000Z',
} satisfies PublicProfilePackageItem

const unpublishedPackage = {
	name: '@kody/notes',
	kodyId: 'notes',
	description: 'Private notes helper.',
	tags: [],
	updatedAt: '2026-07-01T00:00:00.000Z',
	communityListingId: null,
	communityPublishedAt: null,
} satisfies PublicProfilePackageItem

test('profile packages link listings and expose follow controls next to the username', async () => {
	const guestHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: null,
		isSelf: false,
		loggedIn: false,
		isFollowing: false,
		returnTo: '/@kody',
		followError: null,
	})

	expect(guestHtml).toContain('href="/community/listing-1"')
	expect(guestHtml.match(/fathom-analytics/g)).toHaveLength(1)
	expect(guestHtml).toContain('href="/community/listing-1#fork-title"')
	// Listed packages get one fork control; unpublished packages do not.
	expect(guestHtml.match(/aria-label="fork"/g)).toHaveLength(1)
	expect(guestHtml).toContain('notes')
	expect(guestHtml).not.toContain('href="/community/notes')
	expect(guestHtml).toContain('data-testid="profile-follow"')
	expect(guestHtml).toContain('/login?redirectTo=%2F%40kody')

	const followingHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		isSelf: false,
		loggedIn: true,
		isFollowing: true,
		returnTo: '/@kody',
		followError: 'Unable to follow.',
	})

	expect(followingHtml).toContain('data-testid="profile-username"')
	expect(followingHtml).toContain('data-testid="profile-follow"')
	expect(followingHtml).toContain('data-following="true"')
	expect(followingHtml).toContain('/profiles/kody/follow.json')
	expect(followingHtml).toContain('data-testid="profile-follow-error"')
	expect(followingHtml.indexOf('data-testid="profile-follow"')).toBeGreaterThan(
		followingHtml.indexOf('data-testid="profile-username"'),
	)

	const ownHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		isSelf: true,
		loggedIn: true,
		isFollowing: false,
		returnTo: '/@kody',
		followError: null,
	})

	expect(ownHtml).toContain('@kody')
	expect(ownHtml).not.toContain('data-testid="profile-follow"')
})

test('package cards separate the published date from local edits', async () => {
	const guestHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: null,
		isSelf: false,
		loggedIn: false,
		isFollowing: false,
		returnTo: '/@kody',
		followError: null,
	})

	// Listed packages report the listing's published date, not the owner's
	// unpublished local edit, which is what made the activity feed look stale.
	expect(guestHtml).toContain('Published July 28, 2026')
	expect(guestHtml).not.toContain('August 7, 2026')
	expect(guestHtml).toContain('Edited July 1, 2026')
	expect(guestHtml).toContain('data-testid="profile-activity-hint"')

	const ownHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage],
		activity: [],
		query: null,
		isSelf: true,
		loggedIn: true,
		isFollowing: false,
		returnTo: '/@kody',
		followError: null,
	})

	// Owners also see that the listing is behind their local edits.
	expect(ownHtml).toContain('edited August 7, 2026, not republished')
})
