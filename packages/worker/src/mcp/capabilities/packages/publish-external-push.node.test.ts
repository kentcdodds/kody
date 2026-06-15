import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	captureException: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceById: vi.fn(),
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
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
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

const { publishExternalPushCapability } =
	await import('./publish-external-push.ts')

function setupDefaultMocks() {
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'demo-package',
		name: '@kentcdodds/demo-package',
		sourceId: 'source-1',
	})
	mockModule.getEntitySourceById.mockResolvedValue({
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

test('publishes a new external Artifacts HEAD', async () => {
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

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('published')
	expect(result).toEqual(
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
})

test('returns already_published when Artifacts HEAD matches D1', async () => {
	setupDefaultMocks()
	const targets = [
		{
			kind: 'service',
			artifactName: 'inbox',
			entryPoint: 'src/service.ts',
			bundleKind: 'module',
		},
	]
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-old',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'already_published',
		published_commit: 'commit-old',
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result).toEqual({
		status: 'already_published',
		published_commit: 'commit-old',
		static_dependents: expect.objectContaining({
			total: 0,
			stale: 0,
			truncated: false,
			items: [],
		}),
	})
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			newCommit: 'commit-old',
		}),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith({
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-old',
		target: targets[0],
		baseUrl: 'https://kody.test',
	})
})

test('already_published without a commit fails instead of silently skipping artifact rebuild', async () => {
	setupDefaultMocks()
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
})

test('published output lists stale static dependents for the new dependency commit', async () => {
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

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result).toEqual(
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
	expect(mockModule.getStaticPackageDependentsSummary).toHaveBeenCalledWith({
		db: expect.any(Object),
		userId: 'user-1',
		sourceId: 'source-1',
		currentDependencyCommit: 'commit-new',
	})
})

test('rebuilds published package bundle artifacts one target at a time after publish', async () => {
	setupDefaultMocks()
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
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('published')
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
	setupDefaultMocks()
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})

	try {
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
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				'package_publish_external_push transient Durable Object reset',
			),
		)
		expect(mockModule.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				tags: {
					scope: 'package_publish_external_push.transient-do-reset',
				},
			}),
		)

		setupDefaultMocks()
		mockModule.getEntitySourceById
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
			'package_publish_external_push could not recover after 3 transient Durable Object reset attempts',
		)
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(3)
		expect(mockModule.captureException).toHaveBeenCalledTimes(3)
	} finally {
		warnSpy.mockRestore()
	}
})

test('check failure leaves mutation to the shared publish pipeline', async () => {
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad types' }],
		manifest: {},
		run_id: 'run-1',
	})

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result).toEqual({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad types' }],
		manifest: {},
		run_id: 'run-1',
	})
})
