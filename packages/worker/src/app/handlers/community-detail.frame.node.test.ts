import { expect, test, vi } from 'vitest'
import { createCommunityDetailHandler } from './community-detail.tsx'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingWithAggregates: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
	getUserFollow: vi.fn(),
	listCommunityForksByListingIdsAndUser: vi.fn(),
	listSavedPackagesByKodyIds: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mockModule.getCommunityListingWithAggregates(...args),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/social-repo.ts', () => ({
	getCommunityStar: vi.fn().mockResolvedValue(false),
	getUserFollow: (...args: Array<unknown>) => mockModule.getUserFollow(...args),
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	listCommunityForksByListingIdsAndUser: (...args: Array<unknown>) =>
		mockModule.listCommunityForksByListingIdsAndUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByKodyIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByKodyIds(...args),
	listSavedPackagesByIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByIds(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

const sampleListing = {
	id: 'listing-1',
	ownerUserId: 'owner-mcp-id',
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
	starCount: 0,
} satisfies CommunityListingWithAggregates

const env = {} as Env

test('community detail handler returns bare detail frame HTML for target header', async () => {
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	mockModule.getMcpUserPackageScope.mockResolvedValue('viewer')
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.getUserFollow.mockResolvedValue(false)

	const handler = createCommunityDetailHandler(env)
	const publicResponse = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const publicHtml = await publicResponse.text()

	expect(publicResponse.status).toBe(200)
	expect(publicResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(publicHtml).toContain('data-testid="community-detail-frame"')
	expect(publicHtml).toContain('data-testid="community-listing-icon-detail"')
	expect(publicHtml).toContain('/community/listing-1/icon/abc1234567890')
	expect(publicHtml).toContain('href="/@kentcdodds"')
	expect(publicHtml).toContain('>@kentcdodds</a>')
	expect(publicHtml).toContain('data-testid="community-detail-owner-follow"')
	expect(publicHtml).toContain('title="Follow"')
	expect(publicHtml).toContain('/login?redirectTo=%2Fcommunity%2Flisting-1')
	expect(publicHtml).not.toContain(
		'data-testid="community-detail-owner-private"',
	)
	expect(publicHtml).toContain('data-testid="community-detail-forks"')
	expect(publicHtml).not.toContain('<html')

	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'private',
		stable_user_id: 'owner-mcp-id',
	})
	const privateResponse = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const privateHtml = await privateResponse.text()
	expect(privateHtml).toContain('by @kentcdodds')
	expect(privateHtml).toContain('data-testid="community-detail-owner-private"')
	expect(privateHtml).toContain('title="This profile is private"')
	expect(privateHtml).not.toContain('href="/@kentcdodds"')
	expect(privateHtml).not.toContain(
		'data-testid="community-detail-owner-follow"',
	)

	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'viewer-mcp-id', username: 'burhan' },
		roles: [],
	})
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listSavedPackagesByKodyIds.mockResolvedValue([
		{
			id: 'pkg-github',
			kodyId: 'github-triage',
			name: '@burhan/github-triage',
			sourceId: 'src-github',
		},
	])
	const signedInResponse = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const signedInHtml = await signedInResponse.text()
	expect(signedInHtml).toContain('data-testid="community-detail-owner-follow"')
	expect(signedInHtml).toContain(
		'data-testid="community-detail-viewer-install-badge"',
	)
	expect(signedInHtml).toContain('Installed')
	expect(
		signedInHtml.indexOf('data-testid="community-detail-viewer-install-badge"'),
	).toBeGreaterThan(signedInHtml.indexOf('</h1>'))
	expect(signedInHtml).toContain('name="follow"')
	expect(signedInHtml).toContain('name="returnTo"')
	expect(signedInHtml).toContain('/profiles/kentcdodds/follow.json')
	expect(signedInHtml).toContain('title="Follow"')

	mockModule.getUserFollow.mockResolvedValue(true)
	const followingResponse = await handler.handler({
		request: new Request('https://example.com/community/listing-1', {
			headers: { 'x-remix-target': 'community-detail' },
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1'),
	} as never)
	const followingHtml = await followingResponse.text()
	expect(followingHtml).toContain('data-following="true"')
	expect(followingHtml).toContain('title="Unfollow"')

	const followErrorResponse = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1?followError=You%20cannot%20follow%20yourself.',
			{
				headers: { 'x-remix-target': 'community-detail' },
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL(
			'https://example.com/community/listing-1?followError=You%20cannot%20follow%20yourself.',
		),
	} as never)
	const followErrorHtml = await followErrorResponse.text()
	expect(followErrorHtml).toContain(
		'data-testid="community-detail-owner-follow-error"',
	)
	expect(followErrorHtml).toContain('You cannot follow yourself.')
})
