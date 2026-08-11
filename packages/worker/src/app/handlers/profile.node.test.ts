import { expect, test, vi } from 'vitest'
import {
	createProfileApiHandler,
	createProfileFollowApiPostHandler,
	createProfileHandler,
} from './profile.tsx'
import { CommunityActionError } from '#worker/community/errors.ts'
import { type CommunityProfileRecord } from '#worker/community/types.ts'
import type * as FrameRegistry from '#app/frame-registry.ts'

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

vi.mock('#app/frame-registry.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof FrameRegistry>()
	return {
		...actual,
		handleFrameRequest: vi.fn(
			async (request: Request, _env: Env, _pathname: string) => {
				if (request.headers.get('x-remix-target') === 'profile') {
					return actual.createFrameHtmlResponse(
						'<div data-testid="profile-frame"><span data-testid="profile-display-name">Alice</span></div>',
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
	followerCount: 2,
	followingCount: 1,
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
		communityListingId: 'listing-1',
		communityPublishedAt: '2026-07-01T00:00:00.000Z',
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

const env = {} as Env

function setupPublicProfileMocks() {
	mockModule.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mockModule.listPublicProfilePackages.mockResolvedValue(packageFixture)
	mockModule.getProfileActivity.mockResolvedValue(activityFixture)
	mockModule.getUserFollow.mockResolvedValue(false)
}

test('profile API and page respect visibility and expose packages/activity', async () => {
	const apiHandler = createProfileApiHandler(env)
	const pageHandler = createProfileHandler(env)

	// Public profile for anonymous viewer.
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	setupPublicProfileMocks()

	const publicResponse = await apiHandler.handler({
		request: new Request('https://example.com/profiles/alice.json'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice.json'),
	} as never)
	const publicBody = await publicResponse.json()
	expect(publicResponse.status).toBe(200)
	expect(publicBody.ok).toBe(true)
	expect(publicBody.profile.displayName).toBe('Alice')
	expect(publicBody.packages).toHaveLength(1)
	expect(publicBody.activity).toHaveLength(1)
	expect(publicBody.isSelf).toBe(false)
	expect(publicBody.loggedIn).toBe(false)

	// Private profile hidden from others.
	mockModule.getCommunityProfileByUsername.mockResolvedValue({
		...publicProfile,
		visibility: 'private',
	})
	const privateResponse = await apiHandler.handler({
		request: new Request('https://example.com/profiles/alice.json'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice.json'),
	} as never)
	expect(privateResponse.status).toBe(404)
	expect((await privateResponse.json()).ok).toBe(false)

	// Unknown profile.
	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	const unknownResponse = await apiHandler.handler({
		request: new Request('https://example.com/profiles/missing.json'),
		params: { username: 'missing' },
		url: new URL('https://example.com/profiles/missing.json'),
	} as never)
	expect(unknownResponse.status).toBe(404)

	// Own private profile visible to self.
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
	const ownResponse = await apiHandler.handler({
		request: new Request('https://example.com/profiles/alice.json'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice.json'),
	} as never)
	const ownBody = await ownResponse.json()
	expect(ownResponse.status).toBe(200)
	expect(ownBody.ok).toBe(true)
	expect(ownBody.isSelf).toBe(true)
	expect(ownBody.profile.visibility).toBe('private')

	// Page shell 404 for unavailable profiles.
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	const shellResponse = await pageHandler.handler({
		request: new Request('https://example.com/@missing'),
		params: { username: 'missing' },
		url: new URL('https://example.com/@missing'),
	} as never)
	const shellBody = await shellResponse.json()
	expect(shellResponse.status).toBe(404)
	expect(shellBody.loaderData.profileShell).toEqual({
		ok: false,
		unavailable: true,
	})

	// Bare profile frame HTML for target header.
	setupPublicProfileMocks()
	const frameResponse = await pageHandler.handler({
		request: new Request('https://example.com/@alice', {
			headers: { 'x-remix-target': 'profile' },
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/@alice'),
	} as never)
	const html = await frameResponse.text()
	expect(frameResponse.status).toBe(200)
	expect(frameResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(html).toContain('data-testid="profile-frame"')
	expect(html).toContain('data-testid="profile-display-name"')
	expect(html).toContain('Alice')
	expect(html).not.toContain('<html')
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

	const formFollow = await handler.handler({
		request: new Request('https://example.com/profiles/alice/follow.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				follow: 'true',
				returnTo: '/community/listing-1',
			}),
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/follow.json'),
	} as never)
	expect(formFollow.status).toBe(303)
	expect(formFollow.headers.get('Location')).toBe('/community/listing-1')

	mockModule.followCommunityUser.mockRejectedValue(
		new CommunityActionError('You cannot follow yourself.'),
	)
	const formError = await handler.handler({
		request: new Request('https://example.com/profiles/alice/follow.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				follow: 'true',
				returnTo: '/community/listing-1',
			}),
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/follow.json'),
	} as never)
	expect(formError.status).toBe(303)
	expect(formError.headers.get('Location')).toBe(
		'/community/listing-1?followError=You+cannot+follow+yourself.',
	)

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
	const errorBody = await errorResponse.json()
	expect(errorBody.ok).toBe(false)
	expect(typeof errorBody.error).toBe('string')
})
