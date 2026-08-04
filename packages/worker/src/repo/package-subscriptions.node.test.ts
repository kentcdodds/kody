import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	getEntitySourceByRepoId: vi.fn(),
	getUserRepoById: vi.fn(),
	getSavedPackageById: vi.fn(),
	ensureArtifactsRepoPushSubscription: vi.fn(async () => ({
		subscriptionId: 'sub-1',
		skipped: false,
	})),
	getArtifactsNamespace: vi.fn(() => 'production'),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	getSavedPackageById: mocks.getSavedPackageById,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceByRepoId: mocks.getEntitySourceByRepoId,
}))

vi.mock('./user-repos.ts', () => ({
	getUserRepoById: mocks.getUserRepoById,
}))

vi.mock('./artifacts-push-subscriptions.ts', () => ({
	ensureArtifactsRepoPushSubscription:
		mocks.ensureArtifactsRepoPushSubscription,
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsNamespace: mocks.getArtifactsNamespace,
}))

const { dispatchRepoSubscriptionEvents, processCloudflareArtifactsRepoEvent } =
	await import('./package-subscriptions.ts')

const source = {
	id: 'source-1',
	user_id: 'user-1',
	entity_kind: 'repo' as const,
	entity_id: 'user-repo-1',
	repo_id: 'repo-user-repo-1',
	published_commit: null,
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-05-18T00:00:00.000Z',
	updated_at: '2026-05-18T00:00:00.000Z',
}

const pushedEvent = {
	type: 'cf.artifacts.repo.pushed' as const,
	source: {
		type: 'artifacts.repo' as const,
		namespace: 'production',
		repoName: 'repo-user-repo-1',
	},
	payload: {
		ref: 'refs/heads/main',
		before: 'abc123def456abc123def456abc123def456abc1',
		after: 'def789ghi012def789ghi012def789ghi012def7',
		commits: [
			{
				id: 'def789ghi012def789ghi012def789ghi012def7',
				message: 'Sync skills',
				messageTruncated: false,
				timestamp: '2026-05-01T02:48:57.000Z',
				author: { name: 'Dev', email: 'dev@example.com' },
				committer: { name: 'Dev', email: 'dev@example.com' },
				parents: ['abc123def456abc123def456abc123def456abc1'],
			},
		],
		totalCommitsCount: 1,
		commitsTruncated: false,
	},
	metadata: {
		accountId: 'account-1',
		eventSubscriptionId: 'subscription-1',
		eventSchemaVersion: 1,
		eventTimestamp: '2026-05-01T02:48:57.132Z',
	},
}

test('repo.pushed fans out only to the owning user packages', async () => {
	const savedPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-pkg-1',
		kodyId: 'skills-resync',
		name: '@user/skills-resync',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/skills-resync',
			kody: {
				id: 'skills-resync',
				description: 'Resync on push',
				subscriptions: {
					'repo.pushed': { handler: './src/on-repo-pushed.ts' },
				},
			},
		},
	})
	mocks.getUserRepoById.mockResolvedValueOnce({
		id: 'user-repo-1',
		userId: 'user-1',
		name: 'skills',
		description: null,
		createdAt: '2026-05-18T00:00:00.000Z',
		updatedAt: '2026-05-18T00:00:00.000Z',
	})
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env

	await dispatchRepoSubscriptionEvents({
		env,
		providerEvent: pushedEvent,
		source,
	})

	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'user-1',
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: 'repo.pushed',
			source: 'repo',
			idempotencyKey:
				'repo-push:repo-user-repo-1:def789ghi012def789ghi012def789ghi012def7:refs/heads/main:package-1',
			params: expect.objectContaining({
				event: 'repo.pushed',
				repo: expect.objectContaining({
					source_id: 'source-1',
					repo_id: 'repo-user-repo-1',
					entity_kind: 'repo',
					name: 'skills',
					kody_id: null,
				}),
				push: expect.objectContaining({
					ref: 'refs/heads/main',
					after: 'def789ghi012def789ghi012def789ghi012def7',
				}),
			}),
		}),
	)
})

test('processCloudflareArtifactsRepoEvent ignores other namespaces and session repos', async () => {
	mocks.getArtifactsNamespace.mockReturnValue('production')
	const env = { APP_DB: {}, ARTIFACTS_NAMESPACE: 'production' } as Env

	const wrongNamespace = await processCloudflareArtifactsRepoEvent({
		env,
		body: {
			...pushedEvent,
			source: { ...pushedEvent.source, namespace: 'preview' },
		},
	})
	expect(wrongNamespace.outcome).toBe('ignored')

	const session = await processCloudflareArtifactsRepoEvent({
		env,
		body: {
			...pushedEvent,
			source: {
				...pushedEvent.source,
				repoName: 'package-abc-session-def',
			},
		},
	})
	expect(session.outcome).toBe('ignored')
})

test('processCloudflareArtifactsRepoEvent maps repoName to entity_sources and dispatches', async () => {
	mocks.getArtifactsNamespace.mockReturnValue('production')
	mocks.getEntitySourceByRepoId.mockResolvedValueOnce(source)
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mocks.getUserRepoById.mockResolvedValueOnce({
		id: 'user-repo-1',
		userId: 'user-1',
		name: 'skills',
		description: null,
		createdAt: '2026-05-18T00:00:00.000Z',
		updatedAt: '2026-05-18T00:00:00.000Z',
	})
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
		ARTIFACTS_NAMESPACE: 'production',
	} as Env

	const result = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(result.outcome).toBe('dispatched')
	expect(mocks.getEntitySourceByRepoId).toHaveBeenCalledWith(
		env.APP_DB,
		'repo-user-repo-1',
	)
})

test('processCloudflareArtifactsRepoEvent returns unmatched when entity_sources is missing', async () => {
	mocks.getArtifactsNamespace.mockReturnValue('production')
	mocks.getEntitySourceByRepoId.mockResolvedValueOnce(null)
	const result = await processCloudflareArtifactsRepoEvent({
		env: { APP_DB: {}, ARTIFACTS_NAMESPACE: 'production' } as Env,
		body: pushedEvent,
	})
	expect(result.outcome).toBe('unmatched')
})
