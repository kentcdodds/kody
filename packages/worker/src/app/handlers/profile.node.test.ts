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
		communityListingKodyId: 'helper',
		communityPublishedAt: '2026-07-01T00:00:00.000Z',
		isPrivate: false,
		hidden: false,
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
	expect(mockModule.listPublicProfilePackages).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerStableUserId: 'stable-alice',
			includePrivate: false,
		}),
	)

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
	expect(mockModule.listPublicProfilePackages).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerStableUserId: 'stable-alice',
			includePrivate: true,
		}),
	)

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
