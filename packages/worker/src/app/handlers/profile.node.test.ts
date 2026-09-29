import { expect, test, vi } from 'vitest'
import { createProfileApiHandler, createProfileHandler } from './profile.tsx'
import { type CommunityProfileRecord } from '#worker/community/types.ts'
import type * as FrameRegistry from '#app/frame-registry.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityProfileByUsername: vi.fn(),
	getProfileActivity: vi.fn(),
	listPublicProfilePackages: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/profile-service.ts', () => ({
	getCommunityProfileByUsername: (...args: Array<unknown>) =>
		mockModule.getCommunityProfileByUsername(...args),
	getProfileActivity: (...args: Array<unknown>) =>
		mockModule.getProfileActivity(...args),
	listPublicProfilePackages: (...args: Array<unknown>) =>
		mockModule.listPublicProfilePackages(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(
		async (input: { title?: string; status?: number; loaderData?: unknown }) =>
			new Response(JSON.stringify(input), {
				status: input.status ?? 200,
				headers: { 'Content-Type': 'application/json' },
			}),
	),
}))

vi.mock('#app/frames/community-listings.ts', () => ({}))
vi.mock('#app/frames/community-detail.ts', () => ({}))
vi.mock('#app/frame-registrations.ts', () => ({}))

vi.mock('#app/frame-registry.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof FrameRegistry>()
	return {
		...actual,
		handleFrameRequest: vi.fn(
			async (request: Request, _env: Env, _pathname: string) => {
				if (request.headers.get('x-remix-target') === 'profile') {
					return actual.createFrameHtmlResponse(
						'<div data-testid="profile-frame"><p data-testid="profile-packages-empty">No public packages to take yet.</p></div>',
					)
				}
				return null
			},
		),
	}
})

const publicProfile = {
	userId: 'stable-alice',
	username: 'alice',
	displayName: 'Alice',
	bio: 'Hello',
	avatarKey: null,
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	publicPackageCount: 1,
	listingCount: 1,
} satisfies CommunityProfileRecord

const packageFixture = [
	{
		packageId: 'pkg-1',
		name: '@alice/helper',
		kodyId: 'helper',
		description: 'Helpful package',
		tags: ['tools'],
		updatedAt: '2026-07-01T00:00:00.000Z',
		createdAt: '2026-06-01T00:00:00.000Z',
		communityListingId: 'listing-1',
		communityListingKodyId: 'helper',
		communityPublishedAt: '2026-07-01T00:00:00.000Z',
		needsRepublish: false,
		hasPackage: true,
		hasApp: false,
		webhookCount: 0,
		jobCount: 0,
		isPrivate: false,
		hidden: false,
		publishedCommit: 'abc1234567890',
		listingIconCommit: 'abc1234567890',
	},
]

const activityFixture = [
	{
		type: 'listing_published' as const,
		actorUserId: 'stable-alice',
		actorUsername: 'alice',
		actorDisplayName: 'Alice',
		actorAvatarKey: null,
		listingId: 'listing-1',
		listingName: '@alice/helper',
		listingKodyId: 'helper',
		createdAt: '2026-07-01T00:00:00.000Z',
	},
]

type ProfileResponseBody = {
	ok: boolean
	query?: string | null
	packages?: Array<unknown>
	activity?: Array<unknown>
	loaderData?: { profileShell?: unknown; profileList?: unknown }
}

const env = {} as Env
const apiKeys = [
	'activity',
	'isSelf',
	'loggedIn',
	'ok',
	'packages',
	'profile',
	'query',
]

function setupPublicProfileMocks() {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mockModule.listPublicProfilePackages.mockResolvedValue(packageFixture)
	mockModule.getProfileActivity.mockResolvedValue(activityFixture)
}

async function call(
	create: typeof createProfileApiHandler | typeof createProfileHandler,
	path: string,
	username = 'alice',
) {
	mockModule.listPublicProfilePackages.mockClear()
	const url = new URL(`https://example.com${path}`)
	const response = await create(env).handler({
		request: new Request(url),
		params: { username },
		url,
	} as never)
	return {
		status: response.status,
		body: (await response.json()) as ProfileResponseBody,
	}
}

function lastPackagesQuery() {
	return mockModule.listPublicProfilePackages.mock.calls.at(-1)?.[0]
}

test('profile API respects visibility, ignores owner-only filters for guests, and forwards search limits', async () => {
	setupPublicProfileMocks()
	const guest = await call(createProfileApiHandler, '/profiles/alice.json')
	expect(guest.status).toBe(200)
	expect(Object.keys(guest.body).sort()).toEqual(apiKeys)
	expect(guest.body).toMatchObject({
		ok: true,
		profile: { displayName: 'Alice' },
		packages: [{ iconUrl: '/community/listing-1/icon/abc1234567890' }],
		isSelf: false,
		loggedIn: false,
	})
	expect(guest.body.packages).toHaveLength(1)
	expect(guest.body.activity).toHaveLength(1)
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: 'stable-alice',
		includePrivate: false,
	})
	expect(lastPackagesQuery()).not.toHaveProperty('limit')

	const guestFilter = await call(
		createProfileApiHandler,
		'/profiles/alice.json?visibility=private&listing=published&hidden=yes',
	)
	expect(guestFilter.status).toBe(200)
	expect(Object.keys(guestFilter.body).sort()).toEqual(apiKeys)
	expect(lastPackagesQuery()).toMatchObject({ includePrivate: false })

	const search = await call(
		createProfileApiHandler,
		'/profiles/alice.json?q=helper',
	)
	expect(search.status).toBe(200)
	expect(search.body.query).toBe('helper')
	expect(search.body.packages).toHaveLength(1)
	expect(lastPackagesQuery()).toMatchObject({ includePrivate: false })
	expect(lastPackagesQuery()).not.toHaveProperty('query')

	const capped = await call(
		createProfileApiHandler,
		'/profiles/alice.json?q=helper&limit=10',
	)
	expect(capped.status).toBe(200)
	expect(lastPackagesQuery()).toMatchObject({
		includePrivate: false,
		query: 'helper',
		limit: 10,
	})

	mockModule.getCommunityProfileByUsername.mockResolvedValue({
		...publicProfile,
		visibility: 'private',
	})
	const hidden = await call(createProfileApiHandler, '/profiles/alice.json')
	expect(hidden.status).toBe(404)
	expect(hidden.body.ok).toBe(false)

	mockModule.getCommunityProfileByUsername.mockResolvedValueOnce(null)
	const unknown = await call(
		createProfileApiHandler,
		'/profiles/missing.json',
		'missing',
	)
	expect(unknown.status).toBe(404)

	// Own private profile is visible to self, including private packages.
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: 'stable-alice' },
	})
	mockModule.listPublicProfilePackages.mockResolvedValue([])
	mockModule.getProfileActivity.mockResolvedValue([])
	const own = await call(
		createProfileApiHandler,
		'/profiles/alice.json?visibility=private&listing=ahead&hidden=yes',
	)
	expect(own.status).toBe(200)
	expect(Object.keys(own.body).sort()).toEqual(apiKeys)
	expect(own.body).toMatchObject({
		ok: true,
		isSelf: true,
		profile: { visibility: 'private' },
	})
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: 'stable-alice',
		includePrivate: true,
	})
})

test('profile page shell embeds the person and the unfiltered package list, or 404s when unavailable', async () => {
	setupPublicProfileMocks()
	const page = await call(createProfileHandler, '/@alice')
	expect(page.status).toBe(200)
	expect(page.body.loaderData?.profileShell).toEqual({
		ok: true,
		username: 'alice',
		displayName: 'Alice',
		bio: 'Hello',
		avatarUrl: null,
		joinedAt: '2026-01-01T00:00:00.000Z',
		isSelf: false,
		loggedIn: false,
		visibility: 'public',
	})
	expect(page.body.loaderData?.profileList).toEqual({
		profile: {
			username: 'alice',
			displayName: 'Alice',
			bio: 'Hello',
			avatarUrl: null,
			visibility: 'public',
			joinedAt: '2026-01-01T00:00:00.000Z',
			publicPackageCount: 1,
			listingCount: 1,
		},
		packages: [
			{
				name: '@alice/helper',
				kodyId: 'helper',
				description: 'Helpful package',
				tags: ['tools'],
				updatedAt: '2026-07-01T00:00:00.000Z',
				createdAt: '2026-06-01T00:00:00.000Z',
				communityListingId: 'listing-1',
				communityListingKodyId: 'helper',
				communityPublishedAt: '2026-07-01T00:00:00.000Z',
				needsRepublish: false,
				hasPackage: true,
				hasApp: false,
				webhookCount: 0,
				jobCount: 0,
				iconUrl: '/community/listing-1/icon/abc1234567890',
			},
		],
		activity: [
			{
				type: 'listing_published',
				actorUsername: 'alice',
				actorDisplayName: 'Alice',
				actorAvatarUrl: null,
				listingId: 'listing-1',
				listingName: '@alice/helper',
				listingKodyId: 'helper',
				createdAt: '2026-07-01T00:00:00.000Z',
			},
		],
	})

	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	const missing = await call(createProfileHandler, '/@missing', 'missing')
	expect(missing.status).toBe(404)
	expect(missing.body.loaderData?.profileShell).toEqual({
		ok: false,
		unavailable: true,
	})
})
