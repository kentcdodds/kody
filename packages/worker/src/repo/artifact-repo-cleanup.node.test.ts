import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	deleteArtifactRepo: vi.fn(),
	getEntitySourceById: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	listEntitySourcesByUser: vi.fn(),
	deleteArtifactsRepoPushSubscription: vi.fn(async () => true),
	getArtifactsPushSubscriptionBySourceId: vi.fn(async () => null),
	deleteArtifactsPushSubscriptionBySourceId: vi.fn(async () => true),
	listRepoSessionsBySource: vi.fn(async () => []),
	listRepoSessionsByUser: vi.fn(async () => []),
	hasArtifactsAccess: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsBinding: () => ({
		delete: (...args: Array<unknown>) => mockModule.deleteArtifactRepo(...args),
	}),
	hasArtifactsAccess: (...args: Array<unknown>) =>
		mockModule.hasArtifactsAccess(...args),
}))

vi.mock('./artifacts-push-subscriptions.ts', () => ({
	deleteArtifactsRepoPushSubscription: (...args: Array<unknown>) =>
		mockModule.deleteArtifactsRepoPushSubscription(...args),
}))

vi.mock('./artifacts-push-subscription-store.ts', () => ({
	getArtifactsPushSubscriptionBySourceId: (...args: Array<unknown>) =>
		mockModule.getArtifactsPushSubscriptionBySourceId(...args),
	deleteArtifactsPushSubscriptionBySourceId: (...args: Array<unknown>) =>
		mockModule.deleteArtifactsPushSubscriptionBySourceId(...args),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
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
	cleanupArtifactReposForSource,
	deleteUserScopedArtifactRepo,
} = await import('./artifact-repo-cleanup.ts')

const env = { APP_DB: {} } as Env

const repoDeleted = { id: 'repo_deleted', alreadyDeleted: false }
const userSource = (userId: string, repoId: string, id = 'source-1') => ({
	id,
	user_id: userId,
	repo_id: repoId,
})
const sourceCleanupInput = { env, userId: 'user-1', sourceId: 'source-1' }

test('artifact repo cleanup deletes scoped repos and records warning-only failures', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo
		.mockResolvedValue(repoDeleted)
		.mockResolvedValueOnce({ id: 'repo_1', alreadyDeleted: false })
		.mockResolvedValueOnce({ id: null, alreadyDeleted: true })

	for (const repoName of ['package-src-1', 'package-src-1-session-abc']) {
		await expect(
			deleteUserScopedArtifactRepo({ env, userId: 'user-1', repoName }),
		).resolves.toBe(true)
	}

	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		userSource('user-1', 'package-pkg-1'),
	)
	mockModule.listRepoSessionsBySource.mockResolvedValueOnce([
		{
			id: 'session-1',
			user_id: 'user-1',
			source_id: 'source-1',
			source_repo_id: 'package-pkg-1',
		},
	])
	await expect(
		cleanupArtifactReposForPackage(sourceCleanupInput),
	).resolves.toBe(1)
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('package-pkg-1')

	mockModule.listEntitySourcesByUser.mockResolvedValue([
		userSource('user-1', 'package-pkg-1'),
		userSource('user-1', 'job-job-1', 'source-2'),
	])
	mockModule.listRepoSessionsByUser.mockResolvedValueOnce([
		{ id: 'session-1', user_id: 'user-1', source_repo_id: 'package-pkg-1' },
	])
	await expect(
		cleanupAllUserArtifactRepos({ env, userId: 'user-1', warnings: [] }),
	).resolves.toBe(2)

	mockModule.listRepoSessionsByUser.mockResolvedValue([])
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		userSource('user-other', 'package-pkg-1'),
	)
	mockModule.deleteArtifactRepo.mockClear()
	const packageWarnings: Array<string> = []
	await expect(
		cleanupArtifactReposForPackage({
			...sourceCleanupInput,
			warnings: packageWarnings,
		}),
	).resolves.toBe(0)
	expect(mockModule.deleteArtifactRepo).not.toHaveBeenCalled()
	expect(packageWarnings).toHaveLength(1)

	mockModule.hasArtifactsAccess.mockReturnValue(false)
	mockModule.listEntitySourcesByUser.mockResolvedValue([
		userSource('user-1', 'package-pkg-1'),
	])
	const accountWarnings: Array<string> = []
	await expect(
		cleanupAllUserArtifactRepos({
			env,
			userId: 'user-1',
			warnings: accountWarnings,
		}),
	).resolves.toBe(0)
	expect(accountWarnings).toHaveLength(1)
})

test('generic source cleanup deletes the source root with user scope checks', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo.mockResolvedValue(repoDeleted)
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		userSource('user-1', 'job-job-1'),
	)
	await expect(
		cleanupArtifactReposForSource(sourceCleanupInput),
	).resolves.toEqual({
		deleted: 1,
		artifactAccessUnavailable: false,
	})
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('job-job-1')
	// No stored push subscription means no Cloudflare subscription delete.
	expect(mockModule.deleteArtifactsRepoPushSubscription).not.toHaveBeenCalled()

	mockModule.deleteArtifactRepo.mockClear()
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		userSource('user-2', 'job-job-1'),
	)
	const warnings: Array<string> = []
	await expect(
		cleanupArtifactReposForSource({ ...sourceCleanupInput, warnings }),
	).resolves.toEqual({
		deleted: 0,
		artifactAccessUnavailable: false,
	})
	expect(mockModule.deleteArtifactRepo).not.toHaveBeenCalled()
	expect(warnings).toHaveLength(1)

	mockModule.hasArtifactsAccess.mockReturnValue(false)
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		userSource('user-1', 'job-job-1'),
	)
	const missingAccessWarnings: Array<string> = []
	await expect(
		cleanupArtifactReposForSource({
			...sourceCleanupInput,
			warnings: missingAccessWarnings,
		}),
	).resolves.toEqual({
		deleted: 0,
		artifactAccessUnavailable: true,
	})
	expect(missingAccessWarnings).toHaveLength(1)
})

test('account cleanup deletes stored Artifacts push subscriptions before repos', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo.mockResolvedValue(repoDeleted)
	mockModule.listEntitySourcesByUser.mockResolvedValue([
		userSource('user-1', 'package-pkg-1'),
	])
	mockModule.getArtifactsPushSubscriptionBySourceId.mockResolvedValue({
		source_id: 'source-1',
		user_id: 'user-1',
		repo_id: 'package-pkg-1',
		subscription_id: 'sub-1',
		created_at: '2026-05-01T00:00:00.000Z',
		updated_at: '2026-05-01T00:00:00.000Z',
	} as never)

	await cleanupAllUserArtifactRepos({ env, userId: 'user-1', warnings: [] })

	expect(mockModule.deleteArtifactsRepoPushSubscription).toHaveBeenCalledWith({
		env,
		subscriptionId: 'sub-1',
		repoName: 'package-pkg-1',
	})
	expect(
		mockModule.deleteArtifactsPushSubscriptionBySourceId,
	).toHaveBeenCalledWith({}, { sourceId: 'source-1', userId: 'user-1' })
	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('package-pkg-1')
})
