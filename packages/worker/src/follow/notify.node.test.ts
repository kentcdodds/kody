import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deliverFollowRecords: vi.fn(async () => undefined),
	deliverListingForkAliases: vi.fn(async () => undefined),
	listActiveFollowsByTarget: vi.fn(
		async (): Promise<Array<{ id: string; status: string }>> => [],
	),
}))

vi.mock('./deliver.ts', () => ({
	deliverFollowRecords: mocks.deliverFollowRecords,
	deliverListingForkAliases: mocks.deliverListingForkAliases,
}))

vi.mock('./repo.ts', () => ({
	hasAppDb: () => true,
	listActiveFollowsByTarget: mocks.listActiveFollowsByTarget,
}))

const { notifyFollowsOfPublishedPackage } = await import('./notify.ts')

const publishedAt = '2026-10-15T12:00:00.000Z'
const listing = {
	listingId: 'listing-1',
	previous: { pinnedCommit: 'old', packageVersion: '1.0.0' as string | null },
	current: { pinnedCommit: 'new', packageVersion: '2.0.0' as string | null },
}

test('a pin move aliases forks even when no follow is active', async () => {
	mocks.deliverFollowRecords.mockClear()
	mocks.deliverListingForkAliases.mockClear()
	mocks.listActiveFollowsByTarget.mockResolvedValueOnce([])
	await notifyFollowsOfPublishedPackage({
		env: { APP_DB: {} } as Env,
		ownerId: 'org-owner',
		packageId: 'pkg-1',
		previousCommit: 'old',
		publishedCommit: 'new',
		publishedAt,
		listing,
	})
	expect(mocks.deliverListingForkAliases).toHaveBeenCalledTimes(1)
	expect(mocks.deliverListingForkAliases).toHaveBeenCalledWith({
		env: expect.anything(),
		listingId: 'listing-1',
		previous: listing.previous,
		current: listing.current,
		publishedAt,
	})
	expect(mocks.deliverFollowRecords).not.toHaveBeenCalled()
})

test('an unchanged listing pin does not emit the fork alias', async () => {
	mocks.deliverFollowRecords.mockClear()
	mocks.deliverListingForkAliases.mockClear()
	mocks.listActiveFollowsByTarget.mockResolvedValueOnce([
		{ id: 'follow-1', status: 'active' },
	])
	await notifyFollowsOfPublishedPackage({
		env: { APP_DB: {} } as Env,
		ownerId: 'org-owner',
		packageId: 'pkg-1',
		previousCommit: 'old',
		publishedCommit: 'new',
		publishedAt,
		listing: {
			...listing,
			current: { pinnedCommit: 'old', packageVersion: '1.0.0' },
		},
	})
	expect(mocks.deliverListingForkAliases).not.toHaveBeenCalled()
	expect(mocks.deliverFollowRecords).toHaveBeenCalledTimes(1)
})
