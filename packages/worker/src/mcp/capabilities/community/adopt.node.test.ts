import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

const mocks = vi.hoisted(() => ({
	adoptCommunityFork: vi.fn(),
	inspectCommunityForkAdoption: vi.fn(),
	getSavedPackageById: vi.fn(),
	authorize: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	adoptCommunityFork: (...args: Array<unknown>) =>
		mocks.adoptCommunityFork(...args),
	inspectCommunityForkAdoption: (...args: Array<unknown>) =>
		mocks.inspectCommunityForkAdoption(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mocks.getSavedPackageById(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		authorize: (...args: Array<unknown>) => mocks.authorize(...args),
	}
})

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
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			...(overrides?.executionOrigin === 'omit'
				? {}
				: {
						executionOrigin: overrides?.executionOrigin ?? 'interactive',
					}),
			user: {
				userId: personIdFromStored(userId),
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

function mockAdoptLookup(packageId = 'pkg-1') {
	mocks.inspectCommunityForkAdoption.mockResolvedValue(unadoptedState)
	mocks.getSavedPackageById.mockResolvedValue({
		id: packageId,
		userId: ownerIdFromStored('user-alice'),
		name: '@alice/demo-fork',
		kodyId: 'demo-fork',
	})
	mocks.authorize.mockResolvedValue(undefined)
}

test('communityForkAdopt returns a website adoption link and never adopts', async () => {
	mockAdoptLookup()

	await expect(
		communityForkAdoptCapability.handler(
			{
				package_id: 'pkg-1',
				review_summary: 'Reviewed auth paths and secret mounts.',
			},
			createContext(),
		),
	).resolves.toMatchObject({
		status: 'approval_required',
		package_id: 'pkg-1',
		kody_id: 'demo-fork',
		listing_id: 'listing-1',
		origin_commit: 'commit-1',
		adopted_at: null,
		approval_url:
			'https://example.com/@alice/demo-fork/settings#community-fork-adoption',
	})
	expect(mocks.inspectCommunityForkAdoption).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('user-alice'),
		packageId: 'pkg-1',
		kodyId: undefined,
	})
	expect(mocks.authorize).toHaveBeenCalled()
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
	for (const overrides of [
		{ executionOrigin: 'omit' },
		{ executionOrigin: 'background' },
		{ executionOrigin: 'interactive', packageId: 'pkg-malicious' },
		{ executionOrigin: 'interactive', appId: 'app-1' },
	] as const) {
		await expect(
			communityForkAdoptCapability.handler(
				{ package_id: 'pkg-1' },
				createContext('user-alice', overrides),
			),
		).rejects.toThrow(
			'communityForkAdopt is unavailable from package runtime contexts',
		)
	}

	expect(mocks.inspectCommunityForkAdoption).not.toHaveBeenCalled()
	expect(mocks.adoptCommunityFork).not.toHaveBeenCalled()
})
