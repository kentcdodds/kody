import { afterEach, expect, test, vi } from 'vitest'

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

afterEach(() => {
	vi.clearAllMocks()
})

test('deleteUserScopedArtifactRepo deletes a repo and treats 404 as success', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
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
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledTimes(2)
})

test('cleanupArtifactReposForPackage deletes session fork repos before entity repo', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
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
	mockModule.deleteArtifactRepo.mockResolvedValue({
		id: 'repo_deleted',
		alreadyDeleted: false,
	})

	const deleted = await cleanupArtifactReposForPackage({
		env,
		userId: 'user-1',
		sourceId: 'source-1',
	})

	expect(deleted).toBe(2)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith(
		'package-pkg-1-abc123',
	)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('package-pkg-1')
	expect(mockModule.getEntitySourceById).toHaveBeenCalledWith({}, 'source-1')
})

test('cleanupArtifactReposForPackage skips repos owned by another user', async () => {
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-other',
		repo_id: 'package-pkg-1',
	})
	const warnings: Array<string> = []

	const deleted = await cleanupArtifactReposForPackage({
		env,
		userId: 'user-1',
		sourceId: 'source-1',
		warnings,
	})

	expect(deleted).toBe(0)
	expect(mockModule.deleteArtifactRepo).not.toHaveBeenCalled()
	expect(warnings[0]).toContain('user scope mismatch')
})

test('cleanupAllUserArtifactRepos deduplicates repos across sources and sessions', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
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
	mockModule.deleteArtifactRepo.mockResolvedValue({
		id: 'repo_deleted',
		alreadyDeleted: false,
	})

	const warnings: Array<string> = []
	const deleted = await cleanupAllUserArtifactRepos({
		env,
		userId: 'user-1',
		warnings,
	})

	expect(deleted).toBe(3)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledTimes(3)
})

test('cleanupAllUserArtifactRepos records a warning when Artifacts access is unavailable', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(false)
	mockModule.listEntitySourcesByUser.mockResolvedValue([
		{ id: 'source-1', user_id: 'user-1', repo_id: 'package-pkg-1' },
	])
	mockModule.listRepoSessionsByUser.mockResolvedValue([])

	const warnings: Array<string> = []
	const deleted = await cleanupAllUserArtifactRepos({
		env,
		userId: 'user-1',
		warnings,
	})

	expect(deleted).toBe(0)
	expect(warnings[0]).toContain('Cloudflare Artifacts access was unavailable')
})
