import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

const mocks = vi.hoisted(() => ({
	adoptCommunityFork: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	adoptCommunityFork: (...args: Array<unknown>) =>
		mocks.adoptCommunityFork(...args),
}))

const { communityForkAdoptCapability } = await import('./adopt.ts')

function createContext(userId = 'user-alice') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId,
				email: 'alice@example.com',
				displayName: 'Alice',
				username: 'alice',
			},
		}),
	}
}

test('community_fork_adopt adopts a reviewed fork', async () => {
	mocks.adoptCommunityFork.mockResolvedValue({
		packageId: 'pkg-1',
		kodyId: 'demo-fork',
		listingId: 'listing-1',
		originCommit: 'commit-1',
		adoptedAt: '2026-07-21T12:00:00.000Z',
		alreadyAdopted: false,
	})

	const result = await communityForkAdoptCapability.handler(
		{
			package_id: 'pkg-1',
			review_summary: 'Reviewed auth paths and secret mounts.',
		},
		createContext(),
	)

	expect(result).toEqual({
		adopted: true,
		already_adopted: false,
		package_id: 'pkg-1',
		kody_id: 'demo-fork',
		listing_id: 'listing-1',
		origin_commit: 'commit-1',
		adopted_at: '2026-07-21T12:00:00.000Z',
	})
	expect(mocks.adoptCommunityFork).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'user-alice',
		packageId: 'pkg-1',
		kodyId: undefined,
		reviewSummary: 'Reviewed auth paths and secret mounts.',
	})
})

test('community_fork_adopt accepts kody_id and surfaces not-a-fork errors', async () => {
	mocks.adoptCommunityFork.mockResolvedValue({
		packageId: 'pkg-1',
		kodyId: 'demo-fork',
		listingId: 'listing-1',
		originCommit: 'commit-1',
		adoptedAt: '2026-07-21T12:00:00.000Z',
		alreadyAdopted: true,
	})

	await expect(
		communityForkAdoptCapability.handler(
			{
				kody_id: 'demo-fork',
				review_summary: 'Already reviewed; confirming adoption.',
			},
			createContext(),
		),
	).resolves.toMatchObject({
		adopted: true,
		already_adopted: true,
		kody_id: 'demo-fork',
	})

	mocks.adoptCommunityFork.mockRejectedValue(
		new CommunityActionError(
			'Package "demo" is already self-authored; adoption is not needed.',
		),
	)
	await expect(
		communityForkAdoptCapability.handler(
			{
				package_id: 'pkg-self',
				review_summary: 'Trying to adopt a self-authored package.',
			},
			createContext(),
		),
	).rejects.toThrow(/already self-authored/)
})

test('community_fork_adopt rejects short review_summary before calling the service', async () => {
	await expect(
		communityForkAdoptCapability.handler(
			{
				package_id: 'pkg-1',
				review_summary: 'too short',
			},
			createContext(),
		),
	).rejects.toThrow()
	expect(mocks.adoptCommunityFork).not.toHaveBeenCalled()
})
