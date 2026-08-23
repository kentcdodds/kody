import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

const mocks = vi.hoisted(() => ({
	absorbCommunityForkUpstream: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	absorbCommunityForkUpstream: (...args: Array<unknown>) =>
		mocks.absorbCommunityForkUpstream(...args),
}))

const { communityForkAbsorbCapability } = await import('./absorb.ts')

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

test('community_fork_absorb records the listing pin by package_id or kody_id', async () => {
	mocks.absorbCommunityForkUpstream.mockResolvedValue({
		packageId: 'pkg-1',
		kodyId: 'demo-fork',
		listingId: 'listing-1',
		originCommit: 'commit-2',
		listingPinnedCommit: 'commit-2',
		alreadyAbsorbed: false,
	})

	await expect(
		communityForkAbsorbCapability.handler(
			{ package_id: 'pkg-1' },
			createContext(),
		),
	).resolves.toEqual({
		absorbed: true,
		already_absorbed: false,
		package_id: 'pkg-1',
		kody_id: 'demo-fork',
		listing_id: 'listing-1',
		origin_commit: 'commit-2',
		listing_pinned_commit: 'commit-2',
		listing_ahead: false,
	})
	expect(mocks.absorbCommunityForkUpstream).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'user-alice',
		packageId: 'pkg-1',
		kodyId: undefined,
	})

	mocks.absorbCommunityForkUpstream.mockResolvedValueOnce({
		packageId: 'pkg-1',
		kodyId: 'demo-fork',
		listingId: 'listing-1',
		originCommit: 'commit-2',
		listingPinnedCommit: 'commit-2',
		alreadyAbsorbed: true,
	})
	await expect(
		communityForkAbsorbCapability.handler(
			{ kody_id: 'demo-fork' },
			createContext(),
		),
	).resolves.toMatchObject({
		absorbed: true,
		already_absorbed: true,
		kody_id: 'demo-fork',
		listing_ahead: false,
	})

	mocks.absorbCommunityForkUpstream.mockRejectedValueOnce(
		new CommunityActionError(
			'Package "demo" is self-authored and has no community listing to absorb.',
		),
	)
	await expect(
		communityForkAbsorbCapability.handler(
			{ package_id: 'pkg-self' },
			createContext(),
		),
	).rejects.toThrow(/self-authored/)
})
