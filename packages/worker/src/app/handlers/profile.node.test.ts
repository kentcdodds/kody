import { expect, test, vi } from 'vitest'
import {
	createProfileApiHandler,
	createProfileFollowApiPostHandler,
	createProfileHandler,
} from './profile.tsx'
import { CommunityActionError } from '#worker/community/errors.ts'
import { type CommunityProfileRecord } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityProfileByUsername: vi.fn(),
	getProfileActivity: vi.fn(),
	listPublicProfilePackages: vi.fn(),
	followCommunityUser: vi.fn(),
	unfollowCommunityUser: vi.fn(),
	getUserFollow: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/social-service.ts', () => ({
	getCommunityProfileByUsername: (...args: Array<unknown>) =>
		mockModule.getCommunityProfileByUsername(...args),
	getProfileActivity: (...args: Array<unknown>) =>
		mockModule.getProfileActivity(...args),
	listPublicProfilePackages: (...args: Array<unknown>) =>
		mockModule.listPublicProfilePackages(...args),
	followCommunityUser: (...args: Array<unknown>) =>
		mockModule.followCommunityUser(...args),
	unfollowCommunityUser: (...args: Array<unknown>) =>
		mockModule.unfollowCommunityUser(...args),
}))

vi.mock('#worker/community/social-repo.ts', () => ({
	getUserFollow: (...args: Array<unknown>) => mockModule.getUserFollow(...args),
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
vi.mock('#app/frames/profile.ts', () => ({}))
vi.mock('#app/frame-registrations.ts', () => ({}))

vi.mock('#app/frame-registry.ts', () => {
	return {
		handleFrameRequest: vi.fn(async () => null),
		registerFrame: vi.fn(),
		pathnameMatchesFrameRoute: vi.fn(() => false),
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
	followerCount: 2,
	followingCount: 1,
	publicPackageCount: 1,
	listingCount: 1,
} satisfies CommunityProfileRecord

const env = {} as Env

test('profile API returns packages and activity for a public profile', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mockModule.listPublicProfilePackages.mockResolvedValue([
		{
			packageId: 'pkg-1',
			name: '@alice/helper',
			kodyId: 'helper',
			description: 'Helpful package',
			tags: ['tools'],
			updatedAt: '2026-07-01T00:00:00.000Z',
			communityListingId: 'listing-1',
		},
	])
	mockModule.getProfileActivity.mockResolvedValue([
		{
			type: 'listing_published',
			actorUserId: 'stable-alice',
			actorUsername: 'alice',
			actorDisplayName: 'Alice',
			actorAvatarKey: null,
			listingId: 'listing-1',
			listingName: '@alice/helper',
			listingKodyId: 'helper',
			createdAt: '2026-07-01T00:00:00.000Z',
		},
	])
	mockModule.getUserFollow.mockResolvedValue(false)

	const handler = createProfileApiHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/profiles/alice.json'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(200)
	expect(body.ok).toBe(true)
	expect(body.profile.displayName).toBe('Alice')
	expect(body.packages).toHaveLength(1)
	expect(body.activity).toHaveLength(1)
	expect(body.isSelf).toBe(false)
	expect(body.loggedIn).toBe(false)
})

test('profile API returns 404 for private and unknown profiles', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue({
		...publicProfile,
		visibility: 'private',
	})

	const handler = createProfileApiHandler(env)
	const privateResponse = await handler.handler({
		request: new Request('https://example.com/profiles/alice.json'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice.json'),
	} as never)
	expect(privateResponse.status).toBe(404)
	expect(await privateResponse.json()).toEqual({
		ok: false,
		error: "This profile isn't available.",
	})

	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	const unknownResponse = await handler.handler({
		request: new Request('https://example.com/profiles/missing.json'),
		params: { username: 'missing' },
		url: new URL('https://example.com/profiles/missing.json'),
	} as never)
	expect(unknownResponse.status).toBe(404)
})

test('profile API returns own private profile', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: 'stable-alice' },
	})
	mockModule.getCommunityProfileByUsername.mockResolvedValue({
		...publicProfile,
		visibility: 'private',
	})
	mockModule.listPublicProfilePackages.mockResolvedValue([])
	mockModule.getProfileActivity.mockResolvedValue([])
	mockModule.getUserFollow.mockResolvedValue(false)

	const handler = createProfileApiHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/profiles/alice.json'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(200)
	expect(body.ok).toBe(true)
	expect(body.isSelf).toBe(true)
	expect(body.profile.visibility).toBe('private')
})

test('profile page returns 404 shell for unavailable profiles', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)

	const handler = createProfileHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/@missing'),
		params: { username: 'missing' },
		url: new URL('https://example.com/@missing'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(404)
	expect(body.loaderData.profileShell).toEqual({
		ok: false,
		unavailable: true,
	})
})

test('profile follow POST enforces auth and toggles follow', async () => {
	const handler = createProfileFollowApiPostHandler(env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler({
		request: new Request('https://example.com/profiles/alice/follow.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ follow: true }),
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/follow.json'),
	} as never)
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-bob' },
	})
	mockModule.followCommunityUser.mockResolvedValue(undefined)
	const follow = await handler.handler({
		request: new Request('https://example.com/profiles/alice/follow.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ follow: true }),
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/follow.json'),
	} as never)
	expect(follow.status).toBe(200)
	expect(await follow.json()).toEqual({ ok: true, following: true })
	expect(mockModule.followCommunityUser).toHaveBeenCalledWith({
		env,
		followerUserId: 'stable-bob',
		followeeUsername: 'alice',
	})

	mockModule.unfollowCommunityUser.mockResolvedValue(undefined)
	const unfollow = await handler.handler({
		request: new Request('https://example.com/profiles/alice/follow.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ follow: false }),
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/follow.json'),
	} as never)
	expect(unfollow.status).toBe(200)
	expect(await unfollow.json()).toEqual({ ok: true, following: false })

	mockModule.followCommunityUser.mockRejectedValue(
		new CommunityActionError('You cannot follow yourself.'),
	)
	const errorResponse = await handler.handler({
		request: new Request('https://example.com/profiles/alice/follow.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ follow: true }),
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/follow.json'),
	} as never)
	expect(errorResponse.status).toBe(400)
	expect(await errorResponse.json()).toEqual({
		ok: false,
		error: 'You cannot follow yourself.',
	})
})
