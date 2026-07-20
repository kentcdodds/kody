import { expect, test, vi } from 'vitest'
import { createProfileHandler } from './profile.tsx'
import { type CommunityProfileRecord } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityProfileByUsername: vi.fn(),
	getProfileActivity: vi.fn(),
	listPublicProfilePackages: vi.fn(),
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
}))

vi.mock('#worker/community/social-repo.ts', () => ({
	getUserFollow: (...args: Array<unknown>) => mockModule.getUserFollow(...args),
}))

const publicProfile = {
	userId: 'stable-alice',
	username: 'alice',
	displayName: 'Alice',
	bio: 'Builder',
	avatarKey: null,
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	followerCount: 1,
	followingCount: 0,
	publicPackageCount: 1,
	listingCount: 1,
} satisfies CommunityProfileRecord

const env = {} as Env

test('profile handler returns bare profile frame HTML for target header', async () => {
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

	const handler = createProfileHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/@alice', {
			headers: { 'x-remix-target': 'profile' },
		}),
		params: { username: 'alice' },
		url: new URL('https://example.com/@alice'),
	} as never)
	const html = await response.text()

	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(html).toContain('data-testid="profile-frame"')
	expect(html).toContain('data-testid="profile-display-name"')
	expect(html).toContain('Alice')
	expect(html).toContain('Community')
	expect(html).toContain('Published')
	expect(html).not.toContain('<html')
})
