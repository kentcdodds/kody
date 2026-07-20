import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	publishCommunityListing: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mocks.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mocks.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mocks.getCommunityListingByOwnerAndPackage(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mocks.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mocks.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: (...args: Array<unknown>) =>
		mocks.publishCommunityListing(...args),
}))

import {
	republishCommunityListingsAfterUsernameChange,
	updatePackagesForUsernameChange,
} from './username-change-packages.ts'

const env = { APP_DB: {} } as Env

function resetMocks() {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageSourceBySourceId.mockReset()
	mocks.getCommunityListingByOwnerAndPackage.mockReset()
	mocks.syncArtifactSourceSnapshot.mockReset()
	mocks.refreshSavedPackageProjection.mockReset()
	mocks.publishCommunityListing.mockReset()
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-new')
	mocks.refreshSavedPackageProjection.mockResolvedValue(undefined)
	mocks.publishCommunityListing.mockResolvedValue({})
}

test('updatePackagesForUsernameChange rewrites packages and flags community republish', async () => {
	resetMocks()
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'pkg-1',
			kodyId: 'demo',
			sourceId: 'source-1',
			name: '@alice/demo',
		},
	])
	mocks.loadPackageSourceBySourceId.mockResolvedValueOnce({
		source: { published_commit: 'commit-old' },
		files: {
			'package.json': `${JSON.stringify(
				{
					name: '@alice/demo',
					exports: { '.': './index.ts' },
					kody: { id: 'demo', description: 'Demo' },
				},
				null,
				'\t',
			)}\n`,
			'index.ts': "import 'kody:@alice/demo'\n",
		},
	})
	mocks.getCommunityListingByOwnerAndPackage.mockResolvedValueOnce({
		status: 'active',
		pinnedCommit: 'commit-old',
	})

	const result = await updatePackagesForUsernameChange({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		previousUsername: 'alice',
		nextUsername: 'bob',
	})

	expect(result.updatedPackages).toHaveLength(1)
	expect(result.updatedPackages[0]).toMatchObject({
		packageId: 'pkg-1',
		kodyId: 'demo',
		previousName: '@alice/demo',
		nextName: '@bob/demo',
		publishedCommit: 'commit-new',
		shouldRepublishCommunityListing: true,
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			expectedPackageScope: 'bob',
			destructiveOverwriteConfirmed: true,
			files: expect.objectContaining({
				'package.json': expect.stringContaining('"name": "@bob/demo"'),
				'index.ts': expect.stringContaining('kody:@bob/demo'),
			}),
		}),
	)
	expect(mocks.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId: 'pkg-1',
			sourceId: 'source-1',
		}),
	)
})

test('updatePackagesForUsernameChange compensates when a later package fails', async () => {
	resetMocks()
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'pkg-1',
			kodyId: 'one',
			sourceId: 'source-1',
			name: '@alice/one',
		},
		{
			id: 'pkg-2',
			kodyId: 'two',
			sourceId: 'source-2',
			name: '@alice/two',
		},
	])
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-2') {
				throw new Error('missing source')
			}
			return {
				source: { published_commit: 'commit-old' },
				files: {
					'package.json': `${JSON.stringify({
						name: '@alice/one',
						exports: { '.': './index.ts' },
						kody: { id: 'one', description: 'One' },
					})}\n`,
				},
			}
		},
	)
	mocks.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)

	await expect(
		updatePackagesForUsernameChange({
			env,
			baseUrl: 'https://example.com',
			userId: 'user-1',
			previousUsername: 'alice',
			nextUsername: 'bob',
		}),
	).rejects.toThrow('missing source')

	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(2)
	expect(mocks.syncArtifactSourceSnapshot.mock.calls[0]?.[0]).toMatchObject({
		expectedPackageScope: 'bob',
	})
	expect(mocks.syncArtifactSourceSnapshot.mock.calls[1]?.[0]).toMatchObject({
		expectedPackageScope: 'alice',
	})
})

test('republishCommunityListingsAfterUsernameChange collects warnings', async () => {
	resetMocks()
	mocks.publishCommunityListing
		.mockResolvedValueOnce({})
		.mockRejectedValueOnce(new Error('delisted'))

	const result = await republishCommunityListingsAfterUsernameChange({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		packageIds: ['pkg-1', 'pkg-2'],
	})

	expect(result.republishedPackageIds).toEqual(['pkg-1'])
	expect(result.warnings).toHaveLength(1)
	expect(result.warnings[0]).toContain('pkg-2')
})
