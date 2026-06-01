import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	deleteArtifactRepo: vi.fn(),
	getEntitySourceById: vi.fn(),
	listEntitySourcesByUser: vi.fn(),
	listRepoSessionsBySource: vi.fn(),
	listRepoSessionsByUser: vi.fn(),
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

vi.mock('./repo-sessions.ts', () => ({
	listRepoSessionsBySource: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsBySource(...args),
	listRepoSessionsByUser: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsByUser(...args),
}))

const {
	cleanupAllUserArtifactRepos,
	cleanupArtifactReposForPackage,
	deleteUserScopedArtifactRepo,
} = await import('./artifact-repo-cleanup.ts')

const env = { APP_DB: {} } as Env

test('artifact repo cleanup deletes scoped repos, package session forks, and deduplicated user repos', async () => {
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
	mockModule.listRepoSessionsBySource.mockResolvedValue([
		{
			id: 'session-1',
			user_id: 'user-1',
			source_id: 'source-1',
			session_repo_name: 'package-pkg-1-abc123',
		},
	])

	expect(
		await cleanupArtifactReposForPackage({
			env,
			userId: 'user-1',
			sourceId: 'source-1',
		}),
	).toBe(2)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith(
		'package-pkg-1-abc123',
	)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('package-pkg-1')

	mockModule.listEntitySourcesByUser.mockResolvedValue([
		{ id: 'source-1', user_id: 'user-1', repo_id: 'package-pkg-1' },
		{ id: 'source-2', user_id: 'user-1', repo_id: 'job-job-1' },
	])
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		{
			id: 'session-1',
			user_id: 'user-1',
			session_repo_name: 'package-pkg-1-abc123',
		},
	])

	expect(
		await cleanupAllUserArtifactRepos({
			env,
			userId: 'user-1',
			warnings: [],
		}),
	).toBe(3)
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
	expect(packageWarnings[0]).toContain('user scope mismatch')

	mockModule.hasArtifactsAccess.mockReturnValue(false)
	mockModule.listEntitySourcesByUser.mockResolvedValue([
		{ id: 'source-1', user_id: 'user-1', repo_id: 'package-pkg-1' },
	])
	mockModule.listRepoSessionsByUser.mockResolvedValue([])
	const accountWarnings: Array<string> = []

	expect(
		await cleanupAllUserArtifactRepos({
			env,
			userId: 'user-1',
			warnings: accountWarnings,
		}),
	).toBe(0)
	expect(accountWarnings[0]).toContain(
		'Cloudflare Artifacts access was unavailable',
	)
})
