import { expect, test, vi } from 'vitest'
import { createCommunityApiHandler } from './community.tsx'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
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
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

const env = {} as Env

test('community API lists active listings and searches when q is provided', async () => {
	mockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])
	mockModule.searchCommunityListings.mockResolvedValue([sampleListing])

	const handler = createCommunityApiHandler(env)

	const listResponse = await handler.handler({
		request: new Request('https://example.com/community.json'),
		params: {},
		url: new URL('https://example.com/community.json'),
	} as never)
	const listBody = await listResponse.json()

	expect(listBody.ok).toBe(true)
	expect(listBody.listings).toHaveLength(1)
	expect(listBody.listings[0]).toMatchObject({
		id: 'listing-1',
		name: '@kentcdodds/github-triage',
		ownerUsername: 'kentcdodds',
	})
	expect(listBody.listings[0]).not.toHaveProperty('ownerUserId')
	expect(listBody.listings[0]).not.toHaveProperty('status')
	expect(mockModule.listCommunityListingsWithAggregates).toHaveBeenCalledWith({
		env,
		includeDelisted: false,
		limit: 50,
		offset: 0,
	})

	const searchResponse = await handler.handler({
		request: new Request('https://example.com/community.json?q=github'),
		params: {},
		url: new URL('https://example.com/community.json?q=github'),
	} as never)
	const searchBody = await searchResponse.json()

	expect(searchBody.ok).toBe(true)
	expect(searchBody.query).toBe('github')
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env,
		query: 'github',
		limit: 50,
	})
})
