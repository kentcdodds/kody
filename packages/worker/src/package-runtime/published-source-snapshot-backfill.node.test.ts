import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	listSavedPackagesPage: vi.fn(),
	loadPackageSourceRowForUser: vi.fn(),
	readPublishedSourceSnapshot: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(),
	readArtifactTreeAtCommit: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesPage: (...args: Array<unknown>) =>
		mocks.listSavedPackagesPage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		mocks.loadPackageSourceRowForUser(...args),
}))

vi.mock('./published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readPublishedSourceSnapshot(...args),
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mocks.writePublishedSourceSnapshot(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactTreeAtCommit: (...args: Array<unknown>) =>
		mocks.readArtifactTreeAtCommit(...args),
}))

const { runPublishedSourceSnapshotBackfill } =
	await import('./published-source-snapshot-backfill.ts')

const ownerUserId = ownerIdFromStored('user-1')
const env = { APP_DB: {} } as Env

function savedPackage(overrides: Record<string, unknown> = {}) {
	return {
		id: 'package-1',
		userId: ownerUserId,
		name: '@scope/demo',
		kodyId: 'demo',
		sourceId: 'source-1',
		...overrides,
	}
}

function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: ownerUserId,
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		...overrides,
	}
}

test('dry-run reports missing published source snapshots without writing', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser.mockResolvedValue(sourceRow())
	mocks.readPublishedSourceSnapshot.mockResolvedValue(null)

	const result = await runPublishedSourceSnapshotBackfill({
		env,
		dryRun: true,
	})

	expect(result).toMatchObject({
		dryRun: true,
		scannedPackages: 1,
		publishedPackages: 1,
		packagesNeedingRebuild: 1,
		rebuiltPackages: 0,
		alreadyPresentPackages: 0,
		nextCursor: null,
	})
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			packageId: 'package-1',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			outcome: 'would_rebuild',
		}),
	])
	expect(mocks.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mocks.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('apply rebuilds a missing snapshot from the Artifacts git tip', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser.mockResolvedValue(sourceRow())
	mocks.readPublishedSourceSnapshot
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
	mocks.readArtifactTreeAtCommit.mockResolvedValue({
		'package.json': '{"name":"@scope/demo"}',
	})
	mocks.writePublishedSourceSnapshot.mockResolvedValue('key')

	const result = await runPublishedSourceSnapshotBackfill({
		env,
		dryRun: false,
	})

	expect(result).toMatchObject({
		dryRun: false,
		packagesNeedingRebuild: 1,
		rebuiltPackages: 1,
		failedPackages: 0,
	})
	expect(mocks.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-1',
		commit: 'commit-1',
	})
	expect(mocks.writePublishedSourceSnapshot).toHaveBeenCalledWith({
		env,
		source: expect.objectContaining({
			id: 'source-1',
			published_commit: 'commit-1',
		}),
		files: { 'package.json': '{"name":"@scope/demo"}' },
	})
	expect(result.outcomes[0]).toMatchObject({ outcome: 'rebuilt' })
})

test('apply records failure when the artifact tree cannot be read', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser.mockResolvedValue(sourceRow())
	mocks.readPublishedSourceSnapshot.mockResolvedValue(null)
	mocks.readArtifactTreeAtCommit.mockRejectedValue(new Error('missing object'))

	const result = await runPublishedSourceSnapshotBackfill({
		env,
		dryRun: false,
	})

	expect(result.failedPackages).toBe(1)
	expect(result.rebuiltPackages).toBe(0)
	expect(result.outcomes[0]).toMatchObject({
		outcome: 'failed',
		error: expect.stringContaining('missing object'),
	})
})
