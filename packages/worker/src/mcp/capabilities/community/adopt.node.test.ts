import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

const mocks = vi.hoisted(() => ({
	adoptCommunityFork: vi.fn(),
	inspectCommunityForkAdoption: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	adoptCommunityFork: (...args: Array<unknown>) =>
		mocks.adoptCommunityFork(...args),
	inspectCommunityForkAdoption: (...args: Array<unknown>) =>
		mocks.inspectCommunityForkAdoption(...args),
}))

const { communityForkAdoptCapability } = await import('./adopt.ts')

function createContext(
	userId = 'user-alice',
	overrides?: {
		executionOrigin?: 'interactive' | 'background' | 'omit'
		packageId?: string
		appId?: string
		storageId?: string
	},
) {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			...(overrides?.executionOrigin === 'omit'
				? {}
				: {
						executionOrigin: overrides?.executionOrigin ?? 'interactive',
					}),
			user: {
				userId,
				email: 'alice@example.com',
				displayName: 'Alice',
				username: 'alice',
			},
			storageContext:
				overrides?.packageId || overrides?.appId || overrides?.storageId
					? {
							sessionId: null,
							appId: overrides.appId ?? null,
							packageId: overrides.packageId ?? null,
							storageId: overrides.storageId ?? null,
						}
					: null,
		}),
	}
}

const unadoptedState = {
	packageId: 'pkg-1',
	kodyId: 'demo-fork',
	ownerScope: 'alice',
	listingId: 'listing-1',
	originCommit: 'commit-1',
	adoptedAt: null,
}

test('communityForkAdopt returns a website adoption link and never adopts', async () => {
	mocks.inspectCommunityForkAdoption.mockResolvedValue(unadoptedState)

	await expect(
		communityForkAdoptCapability.handler(
			{
				package_id: 'pkg-1',
				review_summary: 'Reviewed auth paths and secret mounts.',
			},
			createContext(),
		),
	).resolves.toEqual({
		status: 'approval_required',
		package_id: 'pkg-1',
		kody_id: 'demo-fork',
		listing_id: 'listing-1',
		origin_commit: 'commit-1',
		adopted_at: null,
		approval_url:
			'https://example.com/@alice/demo-fork/settings#community-fork-adoption',
		message: expect.stringContaining('Agents cannot adopt community forks'),
	})
	expect(mocks.inspectCommunityForkAdoption).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'user-alice',
		packageId: 'pkg-1',
		kodyId: undefined,
	})
	expect(mocks.adoptCommunityFork).not.toHaveBeenCalled()

	mocks.inspectCommunityForkAdoption.mockResolvedValueOnce({
		...unadoptedState,
		adoptedAt: '2026-07-21T12:00:00.000Z',
	})
	await expect(
		communityForkAdoptCapability.handler(
			{ kody_id: 'demo-fork' },
			createContext(),
		),
	).resolves.toMatchObject({
		status: 'already_adopted',
		kody_id: 'demo-fork',
		adopted_at: '2026-07-21T12:00:00.000Z',
	})

	mocks.inspectCommunityForkAdoption.mockRejectedValueOnce(
		new CommunityActionError(
			'Package "demo" is already self-authored; adoption is not needed.',
		),
	)
	await expect(
		communityForkAdoptCapability.handler(
			{ package_id: 'pkg-self' },
			createContext(),
		),
	).rejects.toThrow(/already self-authored/)
	expect(mocks.adoptCommunityFork).not.toHaveBeenCalled()
})

test('communityForkAdopt refuses package runtime and background callers', async () => {
	const input = { package_id: 'pkg-1' }

	await expect(
		communityForkAdoptCapability.handler(
			input,
			createContext('user-alice', { executionOrigin: 'omit' }),
		),
	).rejects.toThrow(
		'communityForkAdopt is unavailable from package runtime contexts',
	)

	await expect(
		communityForkAdoptCapability.handler(
			input,
			createContext('user-alice', { executionOrigin: 'background' }),
		),
	).rejects.toThrow(
		'communityForkAdopt is unavailable from package runtime contexts',
	)

	await expect(
		communityForkAdoptCapability.handler(
			input,
			createContext('user-alice', {
				executionOrigin: 'interactive',
				packageId: 'pkg-malicious',
			}),
		),
	).rejects.toThrow(
		'communityForkAdopt is unavailable from package runtime contexts',
	)

	await expect(
		communityForkAdoptCapability.handler(
			input,
			createContext('user-alice', {
				executionOrigin: 'interactive',
				appId: 'app-1',
			}),
		),
	).rejects.toThrow(
		'communityForkAdopt is unavailable from package runtime contexts',
	)

	expect(mocks.inspectCommunityForkAdoption).not.toHaveBeenCalled()
	expect(mocks.adoptCommunityFork).not.toHaveBeenCalled()
})
