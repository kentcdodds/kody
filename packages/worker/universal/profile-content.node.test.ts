import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { ProfileContent, type ProfileContentProps } from './profile-content.tsx'
import {
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from './community-public-types.ts'

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
	needsRepublish: true,
	hasApp: true,
	webhookCount: 2,
	jobCount: 1,
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
	needsRepublish: false,
	hasApp: false,
	webhookCount: 0,
	jobCount: 0,
} satisfies PublicProfilePackageItem

async function renderProfileContentHtml(props: ProfileContentProps) {
	return renderToString(jsx(ProfileContent, props))
}

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
	expect(guestEmptyHtml).toContain('No public repositories to take yet.')
	expect(guestEmptyHtml).toContain('data-testid="profile-packages-empty"')
	expect(guestEmptyHtml).not.toContain('data-testid="profile-username"')
	expect(guestEmptyHtml).not.toContain('data-testid="profile-display-name"')

	const ownHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage],
		activity: [],
		query: null,
		isSelf: true,
	})

	expect(ownHtml).toContain('@kody')
	// Owners also see that the listing pin is behind the published commit.
	expect(ownHtml).toContain('edited August 7, 2026, not republished')

	// communityPublish bumps updated_at after published_at even when the pin
	// already matches HEAD / published_commit. That skew is not republish.
	const ownPublishSkewHtml = await renderProfileContentHtml({
		profile,
		packages: [
			{
				...listedPackage,
				updatedAt: '2026-07-28T00:00:01.044Z',
				communityPublishedAt: '2026-07-28T00:00:00.000Z',
				needsRepublish: false,
			},
		],
		activity: [],
		query: null,
		isSelf: true,
	})
	expect(ownPublishSkewHtml).toContain('Published July 28, 2026')
	expect(ownPublishSkewHtml).not.toContain('not republished')

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
	expect(ownInventoryHtml).toContain('title="Hidden"')
	expect(ownInventoryHtml).toContain('title="Private"')
	expect(ownInventoryHtml).toContain('data-icon="lock"')
	expect(ownInventoryHtml).toContain('data-icon="eye"')
	expect(ownInventoryHtml).not.toContain('title="No community listing"')
	expect(ownInventoryHtml).not.toContain('title="Not published"')

	const ownEmptyHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		isSelf: true,
	})
	expect(ownEmptyHtml).toContain('You have no repositories yet.')
	expect(ownEmptyHtml).not.toContain('No public repositories to take yet.')
})

test('profile package filters render owner-only pills, keep other filters in each href, and explain an empty filtered list', async () => {
	const ownHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: 'fathom',
		visibility: 'private',
		listing: 'all',
		hidden: 'all',
		isSelf: true,
	})

	expect(ownHtml).toContain('data-testid="profile-package-filters"')
	expect(ownHtml).toContain('<details')
	expect(ownHtml).toContain('<summary')
	expect(ownHtml).toContain('Filters')
	expect(ownHtml).toContain('min-height: 1.75rem')
	expect(ownHtml).toContain('data-testid="profile-package-filter-visibility"')
	expect(ownHtml).toContain('data-testid="profile-package-filter-listing"')
	expect(ownHtml).toContain('data-testid="profile-package-filter-hidden"')
	expect(ownHtml).toContain('data-testid="profile-package-filter-app"')
	expect(ownHtml).toContain('data-testid="profile-package-sort"')
	expect(ownHtml).toContain('data-prevent-scroll-reset')
	// The selected pill is marked; sibling pills in the same group are not.
	expect(ownHtml).toContain(
		'href="/@kody?q=fathom&amp;visibility=private" aria-current="page"',
	)
	expect(ownHtml).toContain('href="/@kody?q=fathom&amp;visibility=public"')
	expect(ownHtml).not.toContain(
		'href="/@kody?q=fathom&amp;visibility=public" aria-current="page"',
	)
	// Switching one axis keeps the query and the other active filters.
	expect(ownHtml).toContain(
		'href="/@kody?q=fathom&amp;visibility=private&amp;listing=ahead"',
	)
	expect(ownHtml).toContain(
		'href="/@kody?q=fathom&amp;visibility=private&amp;hidden=yes"',
	)
	expect(ownHtml).toContain(
		'href="/@kody?q=fathom&amp;visibility=private&amp;app=yes"',
	)
	expect(ownHtml).toContain(
		'href="/@kody?q=fathom&amp;visibility=private&amp;sort=name"',
	)
	// The visibility "All" pill drops only its own param and is not current.
	expect(ownHtml).toMatch(/<a href="\/@kody\?q=fathom"[^>]*class=/)
	expect(ownHtml).toContain('Needs republish')
	expect(ownHtml).toContain('Has app')
	// Already-loaded packages are narrowed in render, not by a second fetch.
	expect(ownHtml).toContain('No repositories matched these filters.')
	expect(ownHtml).not.toContain('href="/@kody/fathom-analytics"')

	// Guests see listing and app; visibility and hidden stay owner-only.
	const guestHtml = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: null,
		listing: 'published',
		isSelf: false,
	})
	expect(guestHtml).toContain('data-testid="profile-package-filters"')
	expect(guestHtml).toContain('data-testid="profile-package-filter-listing"')
	expect(guestHtml).toContain('data-testid="profile-package-filter-app"')
	expect(guestHtml).toContain(
		'href="/@kody?listing=published" aria-current="page"',
	)
	expect(guestHtml).toContain('href="/@kody?listing=unpublished"')
	expect(guestHtml).toContain('href="/@kody/fathom-analytics"')
	expect(guestHtml).not.toContain('href="/@kody/notes"')
	expect(guestHtml).not.toContain(
		'data-testid="profile-package-filter-visibility"',
	)
	expect(guestHtml).not.toContain('data-testid="profile-package-filter-hidden"')
	expect(guestHtml).not.toContain('visibility=private')
	expect(guestHtml).not.toContain('listing=ahead')

	// A guest profile with nothing to show has nothing to filter either.
	const guestEmptyHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		isSelf: false,
	})
	expect(guestEmptyHtml).not.toContain('data-testid="profile-package-filters"')

	// Owners keep the toolbar when a filter empties the list so they can back out.
	const ownFilteredEmptyHtml = await renderProfileContentHtml({
		profile,
		packages: [],
		activity: [],
		query: null,
		visibility: 'private',
		isSelf: true,
	})
	expect(ownFilteredEmptyHtml).toContain(
		'data-testid="profile-package-filters"',
	)
	expect(ownFilteredEmptyHtml).toContain(
		'No repositories matched these filters.',
	)
	expect(ownFilteredEmptyHtml).toContain('href="/@kody"')
	expect(ownFilteredEmptyHtml).not.toContain('You have no repositories yet.')
})

test('profile repository rows show package, webhook, job, and app signifiers with count tooltips', async () => {
	const html = await renderProfileContentHtml({
		profile,
		packages: [listedPackage, unpublishedPackage],
		activity: [],
		query: null,
		isSelf: true,
	})

	expect(html).toContain('data-testid="profile-package-signifiers"')
	expect(html).toContain('title="Package"')
	expect(html).toContain('data-icon="box"')
	expect(html).toContain('title="2 webhooks"')
	expect(html).toContain('data-icon="cloud"')
	expect(html).toContain('title="1 job"')
	expect(html).toContain('data-icon="briefcase"')
	expect(html).toContain('title="Has an app"')
	expect(html).toContain('data-icon="globe"')
	expect(html).toContain('title="Published to community"')
	expect(html).toContain('data-icon="share"')
	expect(html).toContain('title="No community listing"')
	expect(html).toContain('data-icon="inbox"')
	expect(html).not.toContain('title="0 webhooks"')
	expect(html).not.toContain('title="0 jobs"')
	expect(html).not.toContain('title="Not published"')
})
