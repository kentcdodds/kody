import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { runPublishedImportableArtifactBackfill } from './published-importable-artifact-backfill.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesPage: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
	rebuildPublishedPackageArtifactsViaRepoSession: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesPage: (...args: Array<unknown>) =>
		mocks.listSavedPackagesPage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mocks.loadPackageManifestBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', () => ({
	isPublishedPackageArtifactBuiltForCommit: (...args: Array<unknown>) =>
		mocks.isPublishedPackageArtifactBuiltForCommit(...args),
}))

vi.mock('#mcp/capabilities/repo/package-artifact-rebuild.ts', () => ({
	rebuildPublishedPackageArtifactsViaRepoSession: (...args: Array<unknown>) =>
		mocks.rebuildPublishedPackageArtifactsViaRepoSession(...args),
}))

const owner = ownerIdFromStored('owner-1')
const env = { APP_DB: {} } as Env

function savedPackage(
	overrides: Partial<{
		id: string
		name: string
		sourceId: string
		kodyId: string
	}> = {},
) {
	return {
		id: overrides.id ?? 'pkg-1',
		userId: owner,
		name: overrides.name ?? '@kody/demo',
		kodyId: overrides.kodyId ?? 'demo',
		description: '',
		tags: [],
		searchText: null,
		sourceId: overrides.sourceId ?? 'source-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

test('dry-run reports missing importable-module artifacts without rebuilding', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([
		savedPackage(),
		savedPackage({ id: 'pkg-2', name: '@kody/clean', sourceId: 'source-2' }),
		savedPackage({
			id: 'pkg-3',
			name: '@kody/draft',
			sourceId: 'source-3',
		}),
	])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-3') {
				return {
					source: { id: 'source-3', published_commit: null },
					manifest: { exports: {} },
				}
			}
			return {
				source: {
					id: input.sourceId,
					published_commit: 'commit-1',
				},
				manifest: {
					exports: {
						'.': './src/index.ts',
						'./util': './src/util.ts',
					},
					kody: {},
				},
			}
		},
	)
	mocks.isPublishedPackageArtifactBuiltForCommit.mockImplementation(
		async (input: {
			sourceId: string
			target: { artifactName?: string | null }
		}) => {
			if (input.sourceId === 'source-2') return true
			return input.target.artifactName === '.'
		},
	)

	const result = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		limit: 10,
	})

	expect(result).toMatchObject({
		dryRun: true,
		scannedPackages: 3,
		publishedPackages: 2,
		packagesNeedingRebuild: 1,
		missingImportableArtifacts: 1,
		rebuiltPackages: 0,
		failedPackages: 0,
		alreadyBuiltPackages: 1,
		skippedUnpublished: 1,
		nextCursor: null,
	})
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			outcome: 'would_rebuild',
			missingImportableCount: 1,
		}),
		expect.objectContaining({
			packageId: 'pkg-2',
			outcome: 'already_built',
		}),
		expect.objectContaining({
			packageId: 'pkg-3',
			outcome: 'skipped_unpublished',
		}),
	])
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).not.toHaveBeenCalled()
})

test('apply rebuilds only packages with missing importable-module artifacts', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		source: { id: 'source-1', published_commit: 'commit-abc' },
		manifest: {
			exports: { '.': './src/index.ts' },
			kody: {},
		},
	})
	mocks.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)
	mocks.rebuildPublishedPackageArtifactsViaRepoSession.mockResolvedValue(
		undefined,
	)

	const result = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: false,
		limit: 5,
	})

	expect(result).toMatchObject({
		dryRun: false,
		packagesNeedingRebuild: 1,
		rebuiltPackages: 1,
		failedPackages: 0,
	})
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			outcome: 'rebuilt',
			publishedCommit: 'commit-abc',
			missingImportableCount: 1,
		}),
	])
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			rpcSessionId: 'artifact-backfill-source-1',
			sourceId: 'source-1',
			userId: owner,
			publishedCommit: 'commit-abc',
			baseUrl: 'https://heykody.dev',
		}),
	)
})
