import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	deleteArtifactRepo: vi.fn(),
	getEntitySourceById: vi.fn(),
	listEntitySourcesByUser: vi.fn(),
	hasArtifactsAccess: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsBinding: () => ({
		delete: (...args: Array<unknown>) => mockModule.deleteArtifactRepo(...args),
	}),
	hasArtifactsAccess: (...args: Array<unknown>) =>
		mockModule.hasArtifactsAccess(...args),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	listEntitySourcesByUser: (...args: Array<unknown>) =>
		mockModule.listEntitySourcesByUser(...args),
}))

const {
	cleanupAllUserArtifactRepos,
	cleanupArtifactReposForPackage,
	cleanupArtifactReposForSource,
	deleteUserScopedArtifactRepo,
} = await import('./artifact-repo-cleanup.ts')

const env = { APP_DB: {} } as Env

test('artifact repo cleanup deletes scoped repos and deduplicated user source repos', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo.mockResolvedValue({
		id: 'repo_deleted',
		alreadyDeleted: false,
	})
	mockModule.deleteArtifactRepo.mockResolvedValueOnce({
		id: 'repo_1',
		alreadyDeleted: false,
	})
	mockModule.deleteArtifactRepo.mockResolvedValueOnce({
		id: null,
		alreadyDeleted: true,
	})

	expect(
		await deleteUserScopedArtifactRepo({
			env,
			userId: 'user-1',
			repoName: 'package-src-1',
		}),
	).toBe(true)
	expect(
		await deleteUserScopedArtifactRepo({
			env,
			userId: 'user-1',
			repoName: 'package-src-1-session-abc',
		}),
	).toBe(true)

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'package-pkg-1',
	})
	expect(
		await cleanupArtifactReposForPackage({
			env,
			userId: 'user-1',
			sourceId: 'source-1',
		}),
	).toBe(1)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('package-pkg-1')

	mockModule.listEntitySourcesByUser.mockResolvedValue([
		{ id: 'source-1', user_id: 'user-1', repo_id: 'package-pkg-1' },
		{ id: 'source-2', user_id: 'user-1', repo_id: 'job-job-1' },
	])
	expect(
		await cleanupAllUserArtifactRepos({
			env,
			userId: 'user-1',
			warnings: [],
		}),
	).toBe(2)
})

test('artifact repo cleanup records warnings for scope mismatches and missing Artifacts access', async () => {
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-other',
		repo_id: 'package-pkg-1',
	})
	const packageWarnings: Array<string> = []

	expect(
		await cleanupArtifactReposForPackage({
			env,
			userId: 'user-1',
			sourceId: 'source-1',
			warnings: packageWarnings,
		}),
	).toBe(0)
	expect(mockModule.deleteArtifactRepo).not.toHaveBeenCalled()
	expect(packageWarnings).toHaveLength(1)
	expect(packageWarnings[0]).toMatch(/scope mismatch/i)

	mockModule.hasArtifactsAccess.mockReturnValue(false)
	mockModule.listEntitySourcesByUser.mockResolvedValue([
		{ id: 'source-1', user_id: 'user-1', repo_id: 'package-pkg-1' },
	])
	const accountWarnings: Array<string> = []

	expect(
		await cleanupAllUserArtifactRepos({
			env,
			userId: 'user-1',
			warnings: accountWarnings,
		}),
	).toBe(0)
	expect(accountWarnings).toHaveLength(1)
	expect(accountWarnings[0]).toMatch(/artifacts access/i)
})

test('generic source cleanup deletes the source root with user scope checks', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo.mockResolvedValue({
		id: 'repo-deleted',
		alreadyDeleted: false,
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'job-job-1',
	})
	await expect(
		cleanupArtifactReposForSource({
			env,
			userId: 'user-1',
			sourceId: 'source-1',
		}),
	).resolves.toBe(1)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('job-job-1')

	mockModule.deleteArtifactRepo.mockClear()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-2',
		repo_id: 'job-job-1',
	})
	const warnings: Array<string> = []
	await expect(
		cleanupArtifactReposForSource({
			env,
			userId: 'user-1',
			sourceId: 'source-1',
			warnings,
		}),
	).resolves.toBe(0)
	expect(mockModule.deleteArtifactRepo).not.toHaveBeenCalled()
	expect(warnings[0]).toMatch(/scope mismatch/i)
})
