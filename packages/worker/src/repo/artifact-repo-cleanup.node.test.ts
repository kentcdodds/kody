import { expect, test, vi } from 'vitest'
import { createRepoSessionRow } from '#worker/test-support/run-kody-registry.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as PushSubscriptions from './artifacts-push-subscriptions.ts'
import type * as PushSubscriptionStore from './artifacts-push-subscription-store.ts'
import type * as RepoSessions from './repo-sessions.ts'

const mockModule = vi.hoisted(() => ({
	deleteArtifactRepo: vi.fn(),
	getArtifactRepo: vi.fn(
		async (_repoName?: string): Promise<{ status: string }> => ({
			status: 'not_found',
		}),
	),
	getEntitySourceById: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	listEntitySourcesByUser: vi.fn(),
	deleteArtifactsRepoPushSubscription: vi.fn<
		typeof PushSubscriptions.deleteArtifactsRepoPushSubscription
	>(async () => true),
	getArtifactsPushSubscriptionBySourceId: vi.fn<
		typeof PushSubscriptionStore.getArtifactsPushSubscriptionBySourceId
	>(async () => null),
	deleteArtifactsPushSubscriptionBySourceId: vi.fn<
		typeof PushSubscriptionStore.deleteArtifactsPushSubscriptionBySourceId
	>(async () => true),
	listRepoSessionsBySource: vi.fn<typeof RepoSessions.listRepoSessionsBySource>(
		async () => [],
	),
	listRepoSessionsByUser: vi.fn<typeof RepoSessions.listRepoSessionsByUser>(
		async () => [],
	),
	hasArtifactsAccess: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsBinding: () => ({
		delete: (...args: Array<unknown>) => mockModule.deleteArtifactRepo(...args),
		get: (repoName: string) => mockModule.getArtifactRepo(repoName),
	}),
	hasArtifactsAccess: (...args: Array<unknown>) =>
		mockModule.hasArtifactsAccess(...args),
}))

vi.mock('./artifacts-push-subscriptions.ts', () => ({
	deleteArtifactsRepoPushSubscription: (
		...args: Parameters<
			typeof PushSubscriptions.deleteArtifactsRepoPushSubscription
		>
	) => mockModule.deleteArtifactsRepoPushSubscription(...args),
}))

vi.mock('./artifacts-push-subscription-store.ts', () => ({
	getArtifactsPushSubscriptionBySourceId: (
		...args: Parameters<
			typeof PushSubscriptionStore.getArtifactsPushSubscriptionBySourceId
		>
	) => mockModule.getArtifactsPushSubscriptionBySourceId(...args),
	deleteArtifactsPushSubscriptionBySourceId: (
		...args: Parameters<
			typeof PushSubscriptionStore.deleteArtifactsPushSubscriptionBySourceId
		>
	) => mockModule.deleteArtifactsPushSubscriptionBySourceId(...args),
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
	listRepoSessionsBySource: (
		...args: Parameters<typeof RepoSessions.listRepoSessionsBySource>
	) => mockModule.listRepoSessionsBySource(...args),
	listRepoSessionsByUser: (
		...args: Parameters<typeof RepoSessions.listRepoSessionsByUser>
	) => mockModule.listRepoSessionsByUser(...args),
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
		createRepoSessionRow({
			id: 'session-1',
			userId: 'user-1',
			sourceId: 'source-1',
			sourceRepoId: 'package-pkg-1',
		}),
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
		createRepoSessionRow({
			id: 'session-1',
			userId: 'user-1',
			sourceId: 'source-1',
			sourceRepoId: 'package-pkg-1',
		}),
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

test('deleteUserScopedArtifactRepo waitUntilAbsent polls until get reports not_found', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo.mockResolvedValue(repoDeleted)
	mockModule.getArtifactRepo
		.mockResolvedValueOnce({ status: 'ready' })
		.mockResolvedValueOnce({ status: 'not_found' })

	await expect(
		deleteUserScopedArtifactRepo({
			env,
			userId: 'user-1',
			repoName: 'package-wait-1',
			waitUntilAbsent: true,
			waitUntilAbsentDelayMs: 1,
		}),
	).resolves.toBe(true)

	expect(mockModule.deleteArtifactRepo).toHaveBeenCalledWith('package-wait-1')
	expect(mockModule.getArtifactRepo).toHaveBeenCalledTimes(2)
})

test('deleteUserScopedArtifactRepo waitUntilAbsent returns false when delete stays visible', async () => {
	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.deleteArtifactRepo.mockResolvedValue(repoDeleted)
	mockModule.getArtifactRepo.mockResolvedValue({ status: 'ready' })
	const warnings: Array<string> = []
	consoleWarn.mockImplementation(() => {})

	await expect(
		deleteUserScopedArtifactRepo({
			env,
			userId: 'user-1',
			repoName: 'package-wait-stuck',
			warnings,
			waitUntilAbsent: true,
			waitUntilAbsentAttempts: 2,
			waitUntilAbsentDelayMs: 1,
		}),
	).resolves.toBe(false)

	expect(warnings).toEqual([
		'Artifact repo "package-wait-stuck" still present after delete (ready).',
	])
	expect(mockModule.getArtifactRepo).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('artifact repo delete not yet absent'),
	)
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
