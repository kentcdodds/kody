import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	type CommunityActivityItem,
	type CommunityListingWithAggregates,
	type CommunityProfileRecord,
	type CommunityStargazer,
	type PublicProfilePackage,
} from '#worker/community/types.ts'

const mocks = vi.hoisted(() => ({
	getCommunityProfileByUsername: vi.fn(),
	getCommunityProfileByStableId: vi.fn(),
	updateCommunityProfile: vi.fn(),
	followCommunityUser: vi.fn(),
	unfollowCommunityUser: vi.fn(),
	starCommunityListing: vi.fn(),
	unstarCommunityListing: vi.fn(),
	listStarredCommunityListings: vi.fn(),
	listCommunityStargazersForListing: vi.fn(),
	getCommunityTimeline: vi.fn(),
	getProfileActivity: vi.fn(),
	listPublicProfilePackages: vi.fn(),
	getUserSocialRowByStableId: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
}))

vi.mock('#worker/community/social-service.ts', () => ({
	getCommunityProfileByUsername: (...args: Array<unknown>) =>
		mocks.getCommunityProfileByUsername(...args),
	getCommunityProfileByStableId: (...args: Array<unknown>) =>
		mocks.getCommunityProfileByStableId(...args),
	updateCommunityProfile: (...args: Array<unknown>) =>
		mocks.updateCommunityProfile(...args),
	followCommunityUser: (...args: Array<unknown>) =>
		mocks.followCommunityUser(...args),
	unfollowCommunityUser: (...args: Array<unknown>) =>
		mocks.unfollowCommunityUser(...args),
	starCommunityListing: (...args: Array<unknown>) =>
		mocks.starCommunityListing(...args),
	unstarCommunityListing: (...args: Array<unknown>) =>
		mocks.unstarCommunityListing(...args),
	listStarredCommunityListings: (...args: Array<unknown>) =>
		mocks.listStarredCommunityListings(...args),
	listCommunityStargazersForListing: (...args: Array<unknown>) =>
		mocks.listCommunityStargazersForListing(...args),
	getCommunityTimeline: (...args: Array<unknown>) =>
		mocks.getCommunityTimeline(...args),
	getProfileActivity: (...args: Array<unknown>) =>
		mocks.getProfileActivity(...args),
	listPublicProfilePackages: (...args: Array<unknown>) =>
		mocks.listPublicProfilePackages(...args),
}))

vi.mock('#worker/community/social-repo.ts', () => ({
	getUserSocialRowByStableId: (...args: Array<unknown>) =>
		mocks.getUserSocialRowByStableId(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mocks.getCommunityListingWithAggregates(...args),
}))

const { communityProfileGetCapability } = await import('./profile-get.ts')
const { communityProfileUpdateCapability } = await import('./profile-update.ts')
const { communityFollowCapability } = await import('./follow.ts')
const { communityUnfollowCapability } = await import('./unfollow.ts')
const { communityStarCapability } = await import('./star.ts')
const { communityUnstarCapability } = await import('./unstar.ts')
const { communityTimelineCapability } = await import('./timeline.ts')
const { communityStarredListCapability } = await import('./starred-list.ts')
const { communityGetCapability } = await import('./get.ts')

function createContext(input?: { username?: string; userId?: string }) {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: input?.userId ?? 'user-alice',
				email: 'alice@example.com',
				displayName: 'Alice',
				username: input?.username ?? 'alice',
			},
		}),
	}
}

function makeProfile(
	overrides: Partial<CommunityProfileRecord> = {},
): CommunityProfileRecord {
	return {
		userId: 'user-alice',
		username: 'alice',
		displayName: 'Alice',
		bio: 'Hello',
		avatarKey: null,
		visibility: 'public',
		joinedAt: '2026-01-01T00:00:00.000Z',
		followerCount: 2,
		followingCount: 3,
		publicPackageCount: 1,
		listingCount: 1,
		...overrides,
	}
}

function makePackage(
	overrides: Partial<PublicProfilePackage> = {},
): PublicProfilePackage {
	return {
		packageId: 'pkg-1',
		name: '@alice/demo',
		kodyId: 'demo',
		description: 'Demo package',
		tags: ['demo'],
		updatedAt: '2026-07-01T00:00:00.000Z',
		communityListingId: 'listing-1',
		...overrides,
	}
}

function makeActivity(
	overrides: Partial<CommunityActivityItem> = {},
): CommunityActivityItem {
	return {
		type: 'listing_published',
		actorUserId: 'user-bob',
		actorUsername: 'bob',
		actorDisplayName: 'Bob',
		actorAvatarKey: null,
		listingId: 'listing-1',
		listingName: '@bob/widget',
		listingKodyId: 'widget',
		createdAt: '2026-07-10T00:00:00.000Z',
		...overrides,
	}
}

function makeListing(
	overrides: Partial<CommunityListingWithAggregates> = {},
): CommunityListingWithAggregates {
	return {
		id: 'listing-1',
		ownerUserId: 'user-bob',
		packageId: 'pkg-bob',
		sourceId: 'source-bob',
		kodyId: 'widget',
		name: '@bob/widget',
		description: 'A widget',
		tags: ['widget'],
		searchText: null,
		readmeContent: '# Widget',
		license: 'MIT',
		pinnedCommit: 'commit-1',
		iconCommit: 'commit-1',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T00:00:00.000Z',
		averageStars: 4.5,
		ratingCount: 2,
		averageAdaptationEffort: 2,
		forkCount: 1,
		starCount: 3,
		...overrides,
	}
}

function resetMocks() {
	for (const mock of Object.values(mocks)) {
		mock.mockReset()
	}
}

test('community_profile_get returns own profile with package ids and private visibility', async () => {
	resetMocks()
	const ownProfile = makeProfile({ visibility: 'private', bio: 'Secret' })
	mocks.getCommunityProfileByStableId.mockResolvedValue(ownProfile)
	mocks.listPublicProfilePackages.mockResolvedValue([makePackage()])
	mocks.getProfileActivity.mockResolvedValue([
		makeActivity({
			actorUserId: 'user-alice',
			actorUsername: 'alice',
			actorDisplayName: 'Alice',
		}),
	])

	const result = await communityProfileGetCapability.handler(
		{},
		createContext(),
	)

	expect(mocks.getCommunityProfileByStableId).toHaveBeenCalledWith({
		env: expect.anything(),
		stableUserId: 'user-alice',
		includePrivate: true,
	})
	expect(mocks.getProfileActivity).toHaveBeenCalledWith({
		env: expect.anything(),
		actorUserId: 'user-alice',
		limit: 20,
		isSelf: true,
	})
	expect(result).toMatchObject({
		user_found: true,
		profile: {
			username: 'alice',
			display_name: 'Alice',
			bio: 'Secret',
			visibility: 'private',
			follower_count: 2,
			following_count: 3,
			public_package_count: 1,
			listing_count: 1,
		},
		packages: [
			{
				package_id: 'pkg-1',
				name: '@alice/demo',
				kody_id: 'demo',
				community_listing_id: 'listing-1',
			},
		],
		recent_activity: [
			{
				type: 'listing_published',
				actor_username: 'alice',
				listing_id: 'listing-1',
				public_url: 'https://example.com/community/listing-1',
			},
		],
	})
})

test('community_profile_get omits package ids for other public profiles', async () => {
	resetMocks()
	mocks.getCommunityProfileByUsername.mockResolvedValue(
		makeProfile({
			userId: 'user-bob',
			username: 'bob',
			displayName: 'Bob',
		}),
	)
	mocks.listPublicProfilePackages.mockResolvedValue([
		makePackage({
			packageId: 'pkg-bob',
			name: '@bob/widget',
			kodyId: 'widget',
		}),
	])
	mocks.getProfileActivity.mockResolvedValue([])

	const result = await communityProfileGetCapability.handler(
		{ username: 'bob' },
		createContext(),
	)

	expect(mocks.getCommunityProfileByUsername).toHaveBeenCalledWith({
		env: expect.anything(),
		username: 'bob',
		includePrivate: false,
	})
	expect(mocks.getProfileActivity).toHaveBeenCalledWith({
		env: expect.anything(),
		actorUserId: 'user-bob',
		limit: 20,
		isSelf: false,
	})
	expect(result.user_found).toBe(true)
	expect(result.packages[0]).toEqual({
		name: '@bob/widget',
		kody_id: 'widget',
		description: 'Demo package',
		tags: ['demo'],
		updated_at: '2026-07-01T00:00:00.000Z',
		community_listing_id: 'listing-1',
	})
	expect(result.packages[0]).not.toHaveProperty('package_id')
})

test('community_profile_get hides private profiles of other users', async () => {
	resetMocks()
	mocks.getCommunityProfileByUsername.mockResolvedValue(null)

	const result = await communityProfileGetCapability.handler(
		{ username: 'private-user' },
		createContext(),
	)

	expect(result).toEqual({
		user_found: false,
		profile: null,
		packages: [],
		recent_activity: [],
	})
	expect(mocks.listPublicProfilePackages).not.toHaveBeenCalled()
	expect(mocks.getProfileActivity).not.toHaveBeenCalled()
})

test('community_profile_update resolves numeric user id and returns updated profile', async () => {
	resetMocks()
	mocks.getUserSocialRowByStableId.mockResolvedValue({
		id: 42,
		username: 'alice',
		email: 'alice@example.com',
		stable_user_id: 'user-alice',
		display_name: 'Alice',
		bio: null,
		profile_visibility: 'public',
		created_at: '2026-01-01T00:00:00.000Z',
	})
	mocks.updateCommunityProfile.mockResolvedValue(undefined)
	mocks.getCommunityProfileByStableId.mockResolvedValue(
		makeProfile({
			displayName: 'Alice Updated',
			bio: 'New bio',
			visibility: 'private',
		}),
	)

	const result = await communityProfileUpdateCapability.handler(
		{
			display_name: 'Alice Updated',
			bio: 'New bio',
			visibility: 'private',
		},
		createContext(),
	)

	expect(mocks.updateCommunityProfile).toHaveBeenCalledWith({
		env: expect.anything(),
		numericUserId: 42,
		displayName: 'Alice Updated',
		bio: 'New bio',
		visibility: 'private',
	})
	expect(result).toMatchObject({
		display_name: 'Alice Updated',
		bio: 'New bio',
		visibility: 'private',
	})
})

test('community_follow and community_unfollow happy path and self-follow error', async () => {
	resetMocks()
	mocks.followCommunityUser.mockResolvedValue(undefined)
	mocks.unfollowCommunityUser.mockResolvedValue(undefined)

	await expect(
		communityFollowCapability.handler({ username: 'bob' }, createContext()),
	).resolves.toEqual({ following: true, username: 'bob' })
	expect(mocks.followCommunityUser).toHaveBeenCalledWith({
		env: expect.anything(),
		followerUserId: 'user-alice',
		followeeUsername: 'bob',
	})

	await expect(
		communityUnfollowCapability.handler({ username: 'bob' }, createContext()),
	).resolves.toEqual({ following: false, username: 'bob' })

	mocks.followCommunityUser.mockRejectedValue(
		new CommunityActionError('You cannot follow yourself.'),
	)
	await expect(
		communityFollowCapability.handler({ username: 'alice' }, createContext()),
	).rejects.toThrow('You cannot follow yourself.')
})

test('community_star and community_unstar return star state; community_get includes star_count and stargazers', async () => {
	resetMocks()
	mocks.starCommunityListing.mockResolvedValue(undefined)
	mocks.unstarCommunityListing.mockResolvedValue(undefined)
	mocks.listCommunityStargazersForListing.mockResolvedValue({
		totalStars: 4,
		stargazers: [
			{
				userId: 'user-alice',
				username: 'alice',
				displayName: 'Alice',
				avatarKey: null,
				starredAt: '2026-07-11T00:00:00.000Z',
			} satisfies CommunityStargazer,
		],
	})
	mocks.getCommunityListingWithAggregates.mockResolvedValue(makeListing())

	await expect(
		communityStarCapability.handler(
			{ listing_id: 'listing-1' },
			createContext(),
		),
	).resolves.toEqual({
		starred: true,
		listing_id: 'listing-1',
		star_count: 4,
	})

	await expect(
		communityUnstarCapability.handler(
			{ listing_id: 'listing-1' },
			createContext(),
		),
	).resolves.toEqual({
		starred: false,
		listing_id: 'listing-1',
	})

	const detail = await communityGetCapability.handler(
		{ listing_id: 'listing-1' },
		createContext(),
	)
	expect(detail).toMatchObject({
		listing_id: 'listing-1',
		star_count: 3,
		owner_username: 'bob',
		owner_profile_url: 'https://example.com/@bob',
		stargazers: {
			total_stars: 4,
			recent_stargazers: [
				{
					username: 'alice',
					display_name: 'Alice',
					avatar_url: null,
					starred_at: '2026-07-11T00:00:00.000Z',
				},
			],
		},
	})
})

test('community_timeline maps followed publish events to public urls', async () => {
	resetMocks()
	mocks.getCommunityTimeline.mockResolvedValue([makeActivity()])

	const result = await communityTimelineCapability.handler(
		{ limit: 10 },
		createContext(),
	)

	expect(mocks.getCommunityTimeline).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'user-alice',
		limit: 10,
	})
	expect(result).toEqual({
		items: [
			{
				type: 'listing_published',
				actor_username: 'bob',
				actor_display_name: 'Bob',
				actor_avatar_url: null,
				listing_id: 'listing-1',
				listing_name: '@bob/widget',
				listing_kody_id: 'widget',
				created_at: '2026-07-10T00:00:00.000Z',
				public_url: 'https://example.com/community/listing-1',
			},
		],
	})
})

test('community_starred_list returns summary plus aggregate fields including star_count', async () => {
	resetMocks()
	mocks.listStarredCommunityListings.mockResolvedValue([makeListing()])

	const result = await communityStarredListCapability.handler(
		{},
		createContext(),
	)

	expect(result.items).toEqual([
		expect.objectContaining({
			listing_id: 'listing-1',
			name: '@bob/widget',
			kody_id: 'widget',
			star_count: 3,
			fork_count: 1,
			average_stars: 4.5,
			trusted: false,
			featured: false,
			public_url: 'https://example.com/community/listing-1',
		}),
	])
})
