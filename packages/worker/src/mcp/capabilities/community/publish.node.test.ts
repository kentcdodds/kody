import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	publishCommunityListing: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: (...args: Array<unknown>) =>
		mockModule.publishCommunityListing(...args),
}))

const { communityPublishCapability } = await import('./publish.ts')

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

test('communityPublishCapability maps listing fields and builds public_url', async () => {
	mockModule.publishCommunityListing.mockReset()
	mockModule.publishCommunityListing.mockResolvedValue({
		id: 'listing-1',
		ownerUserId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		kodyId: 'my-package',
		name: '@kody/my-package',
		description: 'A helpful package',
		tags: ['automation'],
		searchText: null,
		readmeContent: '## Intent\nDo things.',
		license: 'MIT',
		pinnedCommit: 'commit-abc',
		status: 'active',
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T12:00:00.000Z',
	})

	const result = await communityPublishCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext(),
	)

	expect(result).toEqual({
		listing_id: 'listing-1',
		name: '@kody/my-package',
		kody_id: 'my-package',
		description: 'A helpful package',
		license: 'MIT',
		pinned_commit: 'commit-abc',
		status: 'active',
		public_url: 'https://heykody.dev/community/listing-1',
		published_at: '2026-07-01T12:00:00.000Z',
	})
	expect(mockModule.publishCommunityListing).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
	})
})
