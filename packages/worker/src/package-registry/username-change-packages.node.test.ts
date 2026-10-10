import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: mocks.loadPackageSourceBySourceId,
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage:
		mocks.getCommunityListingByOwnerAndPackage,
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: mocks.syncArtifactSourceSnapshot,
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: mocks.refreshSavedPackageProjection,
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: mocks.publishCommunityListing,
}))

import {
	republishCommunityListingsAfterUsernameChange,
	updatePackagesForUsernameChange,
} from './username-change-packages.ts'

const env = { APP_DB: {} } as Env
const baseInput = {
	env,
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-1'),
}

function setupMocks(kodyIds: Array<string>) {
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-new')
	mocks.refreshSavedPackageProjection.mockResolvedValue(undefined)
	mocks.publishCommunityListing.mockResolvedValue({})
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce(
		kodyIds.map((kodyId, index) => ({
			id: `pkg-${index + 1}`,
			kodyId,
			sourceId: `source-${index + 1}`,
			name: `@alice/${kodyId}`,
		})),
	)
}

function renameAliceToBob() {
	return updatePackagesForUsernameChange({
		...baseInput,
		previousUsername: 'alice',
		nextUsername: 'bob',
	})
}

test('updatePackagesForUsernameChange rewrites packages and flags community republish', async () => {
	setupMocks(['demo'])
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

	const result = await renameAliceToBob()

	expect(result.updatedPackages).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			kodyId: 'demo',
			previousName: '@alice/demo',
			nextName: '@bob/demo',
			publishedCommit: 'commit-new',
			shouldRepublishCommunityListing: true,
		}),
	])
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
		expect.objectContaining({ packageId: 'pkg-1', sourceId: 'source-1' }),
	)
})

test('updatePackagesForUsernameChange compensates when a later package fails', async () => {
	setupMocks(['one', 'two'])
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-2') throw new Error('missing source')
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

	await expect(renameAliceToBob()).rejects.toThrow('missing source')
	expect(
		mocks.syncArtifactSourceSnapshot.mock.calls.map(
			([input]) => input.expectedPackageScope,
		),
	).toEqual(['bob', 'alice'])
})

test('republishCommunityListingsAfterUsernameChange collects warnings', async () => {
	mocks.publishCommunityListing
		.mockResolvedValueOnce({})
		.mockRejectedValueOnce(new Error('delisted'))

	const result = await republishCommunityListingsAfterUsernameChange({
		...baseInput,
		packageIds: ['pkg-1', 'pkg-2'],
	})

	expect(result.republishedPackageIds).toEqual(['pkg-1'])
	expect(result.warnings).toEqual([expect.stringContaining('pkg-2')])
})
