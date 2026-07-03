import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

const { communitySearchCapability } = await import('./search.ts')

function createCallerContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'kody@example.com',
				displayName: 'Kody',
				username: 'kody',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('communitySearchCapability includes guidance and excludes owner_user_id', async () => {
	mockModule.searchCommunityListings.mockReset()
	mockModule.searchCommunityListings.mockResolvedValue([
		{
			id: 'listing-1',
			ownerUserId: 'owner-secret',
			packageId: 'package-1',
			sourceId: 'source-1',
			kodyId: 'shared-tool',
			name: '@owner/shared-tool',
			description: 'Shared automation',
			tags: ['automation'],
			searchText: null,
			readmeContent: '## Intent\nShare.',
			license: 'MIT',
			pinnedCommit: 'commit-abc',
			status: 'active',
			createdAt: '2026-07-01T00:00:00.000Z',
			updatedAt: '2026-07-01T00:00:00.000Z',
			publishedAt: '2026-07-01T12:00:00.000Z',
			averageStars: 4.5,
			ratingCount: 2,
			averageAdaptationEffort: 2,
			forkCount: 5,
		},
	])

	const result = await communitySearchCapability.handler(
		{ query: 'automation' },
		createCallerContext(),
	)

	expect(result.guidance).toContain('UNTRUSTED')
	expect(result.guidance).toContain('general `search` tool')
	expect(result.matches).toHaveLength(1)
	expect(result.matches[0]).toMatchObject({
		listing_id: 'listing-1',
		owner_anonymous: true,
		public_url: 'https://heykody.dev/community/listing-1',
		average_stars: 4.5,
		rating_count: 2,
		fork_count: 5,
	})
	expect(result.matches[0]).not.toHaveProperty('owner_user_id')
	expect(JSON.stringify(result)).not.toContain('owner-secret')
})
