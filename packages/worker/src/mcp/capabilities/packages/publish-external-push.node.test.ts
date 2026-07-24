import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	captureException: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	listPublishedPackageArtifactTargets: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	getStaticPackageDependentsSummary: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureException: (...args: Array<unknown>) =>
		mockModule.captureException(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mockModule.publishFromExternalRef(...args),
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

vi.mock('#worker/package-runtime/static-package-dependents.ts', () => ({
	getStaticPackageDependentsSummary: (...args: Array<unknown>) =>
		mockModule.getStaticPackageDependentsSummary(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: async () => {
		throw new Error('published source unavailable in unit test')
	},
}))

const { publishExternalPushCapability } =
	await import('./publish-external-push.ts')

function setupDefaultMocks() {
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'demo-package',
		name: '@kentcdodds/demo-package',
		sourceId: 'source-1',
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-old',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
	})
	mockModule.getStaticPackageDependentsSummary.mockResolvedValue({
		total: 0,
		stale: 0,
		truncated: false,
		items: [],
		recommended_next_action:
			'No published bundle artifacts declare a static dependency on this package.',
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([])
	mockModule.rebuildPublishedPackageArtifact.mockResolvedValue({
		ok: true,
		target: {
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
		kvKey: 'bundle-key',
	})
}

function createContext() {
	return {
		env: {
			APP_DB: {
				prepare() {
					return {
						bind() {
							return {
								first: async () => ({ username: 'user' }),
							}
						},
					}
				},
			},
		} as unknown as Env,
		callerContext: {
			baseUrl: 'https://kody.test',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('publishExternalPush publishes HEAD and rebuilds bundle artifacts per target', async () => {
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: {},
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})

	const publishedResult = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(publishedResult.status).toBe('published')
	expect(publishedResult).toEqual(
		expect.objectContaining({
			static_dependents: expect.objectContaining({
				total: 0,
				items: [],
			}),
		}),
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-new',
			expectedHead: 'commit-new',
			allowForce: false,
			rebuildPackageArtifacts: false,
			expectedPackageScope: 'user',
		}),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	const targets = [
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
		{
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'importable-module',
		},
	]
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)
	mockModule.rebuildPublishedPackageArtifact.mockClear()

	const rebuiltResult = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(rebuiltResult.status).toBe('published')
	expect(mockModule.listPublishedPackageArtifactTargets).toHaveBeenCalledWith({
		sourceId: 'source-1',
		userId: 'user-1',
	})
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenNthCalledWith(
		1,
		{
			sourceId: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-new',
			target: targets[0],
			baseUrl: 'https://kody.test',
		},
	)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenNthCalledWith(
		2,
		{
			sourceId: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-new',
			target: targets[1],
			baseUrl: 'https://kody.test',
		},
	)
})

test('publishExternalPush handles already_published branches, stale dependents, and rebuild failures', async () => {
	const targets = [
		{
			kind: 'service',
			artifactName: 'inbox',
			entryPoint: 'src/service.ts',
			bundleKind: 'module',
		},
	]
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-old',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'already_published',
		published_commit: 'commit-old',
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)

	const alreadyPublished = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)
	expect(alreadyPublished).toEqual({
		status: 'already_published',
		published_commit: 'commit-old',
		static_dependents: expect.objectContaining({
			total: 0,
			stale: 0,
			truncated: false,
			items: [],
		}),
		pending_secret_package_approvals: null,
	})
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith({
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-old',
		target: targets[0],
		baseUrl: 'https://kody.test',
	})

	setupDefaultMocks()
	mockModule.rebuildPublishedPackageArtifact.mockClear()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-old',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'already_published',
		published_commit: null,
	})
	await expect(
		publishExternalPushCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		),
	).rejects.toThrow(
		'already published, but no published commit is available to rebuild artifacts',
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: {},
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	mockModule.getStaticPackageDependentsSummary.mockResolvedValue({
		total: 1,
		stale: 1,
		truncated: false,
		items: [
			{
				package_id: 'package-b',
				kody_id: 'package-b',
				name: '@kentcdodds/package-b',
				source_id: 'source-b',
				published_commit: 'commit-b',
				stale: true,
				artifact_count: 1,
				entrypoints: ['src/index.ts'],
				entrypoints_truncated: false,
				bundled_dependency_commit: 'commit-a-old',
				current_dependency_commit: 'commit-new',
				recommended_action:
					'Inspect this dependent package and republish it if its bundled static kody:@ snapshot should include the published dependency commit.',
			},
		],
		recommended_next_action:
			'Inspect stale static dependents and republish only the packages whose bundled snapshot should include this package publish. Kody does not republish dependents automatically.',
	})
	const publishedWithDependents = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)
	expect(publishedWithDependents).toEqual(
		expect.objectContaining({
			status: 'published',
			static_dependents: expect.objectContaining({
				total: 1,
				stale: 1,
				items: [
					expect.objectContaining({
						package_id: 'package-b',
						stale: true,
						bundled_dependency_commit: 'commit-a-old',
						current_dependency_commit: 'commit-new',
					}),
				],
			}),
		}),
	)

	setupDefaultMocks()
	const target = {
		kind: 'module',
		artifactName: '.',
		entryPoint: 'src/index.ts',
		bundleKind: 'module',
	}
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: {},
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([target])
	mockModule.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
		new Error('No matching default export for import "default"'),
	)
	await expect(
		publishExternalPushCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		),
	).rejects.toThrow(/bundle artifact rebuild failed/i)
})

test('force publish passes destructive confirmation through and refuses without allow_force', async () => {
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-rewrite',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'not_fast_forward',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewrite',
		message: 'The external Artifacts HEAD is not a descendant.',
	})

	const refused = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)
	expect(refused.status).toBe('not_fast_forward')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			allowForce: false,
		}),
	)

	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewrite',
		manifest: {},
		checks: [],
	})
	await publishExternalPushCapability.handler(
		{
			package_id: 'package-1',
			allow_force: true,
			confirm_destructive_overwrite: true,
		},
		createContext(),
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenLastCalledWith(
		expect.objectContaining({
			allowForce: true,
			destructiveOverwriteConfirmed: true,
		}),
	)
})

test('publishExternalPush recovers from transient Durable Object resets', async () => {
	consoleWarn.mockImplementation(() => {})
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})

	mockModule.publishFromExternalRef
		.mockRejectedValueOnce(
			new Error('Durable Object exceeded its CPU time limit and was reset'),
		)
		.mockResolvedValueOnce({
			status: 'published',
			previous_commit: 'commit-old',
			published_commit: 'commit-new',
			manifest: {},
			checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
		})

	const recovered = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)
	expect(recovered.status).toBe('published')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(2)
	expect(mockModule.publishFromExternalRef).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			sessionId: 'external-publish-source-1',
		}),
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			sessionId: 'external-publish-source-1-retry-2',
		}),
	)
	expect(mockModule.captureException).toHaveBeenCalledWith(
		expect.any(Error),
		expect.objectContaining({
			tags: {
				scope: 'package_publish_external_push.transient-do-reset',
			},
		}),
	)
	// Each transient reset leaves exactly one retry warn trail.
	expect(consoleWarn).toHaveBeenCalledTimes(1)

	setupDefaultMocks()
	mockModule.getEntitySourceByIdForUser
		.mockResolvedValueOnce({
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'package-package-1',
			published_commit: 'commit-old',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			created_at: '2026-05-04T00:00:00.000Z',
			updated_at: '2026-05-04T00:00:00.000Z',
		})
		.mockResolvedValueOnce({
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'package-package-1',
			published_commit: 'commit-new',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			created_at: '2026-05-04T00:00:00.000Z',
			updated_at: '2026-05-04T00:00:00.000Z',
		})
	mockModule.publishFromExternalRef
		.mockRejectedValueOnce(
			new Error(
				"Durable Object's isolate exceeded its memory limit and was reset",
			),
		)
		.mockResolvedValueOnce({
			status: 'already_published',
			published_commit: 'commit-new',
		})

	const alreadyPublished = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)
	expect(alreadyPublished).toEqual({
		status: 'already_published',
		published_commit: 'commit-new',
		static_dependents: expect.objectContaining({
			total: 0,
			stale: 0,
			truncated: false,
			items: [],
		}),
		pending_secret_package_approvals: null,
	})

	setupDefaultMocks()
	mockModule.captureException.mockClear()
	mockModule.publishFromExternalRef.mockClear()
	mockModule.publishFromExternalRef.mockRejectedValue(
		new Error('Durable Object exceeded its CPU time limit and was reset'),
	)
	await expect(
		publishExternalPushCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		),
	).rejects.toThrow(
		/could not recover after 3 transient Durable Object reset attempts/,
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(3)
	expect(mockModule.captureException).toHaveBeenCalledTimes(3)

	setupDefaultMocks()
	mockModule.publishFromExternalRef.mockClear()
	mockModule.rebuildPublishedPackageArtifact.mockClear()
	const rebuildTarget = {
		kind: 'module',
		artifactName: '.',
		entryPoint: 'src/index.ts',
		bundleKind: 'module',
	}
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([
		rebuildTarget,
	])
	mockModule.publishFromExternalRef
		.mockResolvedValueOnce({
			status: 'published',
			previous_commit: 'commit-old',
			published_commit: 'commit-new',
			manifest: {},
			checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
		})
		.mockResolvedValueOnce({
			status: 'already_published',
			published_commit: 'commit-new',
		})
	mockModule.rebuildPublishedPackageArtifact
		.mockRejectedValueOnce(
			new Error('rebuild target failed', {
				cause: new Error('Durable Object exceeded its CPU time limit'),
			}),
		)
		.mockResolvedValueOnce({
			ok: true,
			target: rebuildTarget,
			kvKey: 'bundle-key',
		})

	const recoveredAfterRebuildReset =
		await publishExternalPushCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		)

	expect(recoveredAfterRebuildReset.status).toBe('already_published')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
})
