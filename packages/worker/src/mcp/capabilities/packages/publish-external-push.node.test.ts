import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	listPublishedPackageArtifactTargets: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	getStaticPackageDependentsSummary: vi.fn(),
	runWithDurableEscalation: vi.fn(),
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

vi.mock('#mcp/capabilities/durable-escalation.ts', () => ({
	defaultDurableEscalationBudgetMs: 55_000,
	buildCallerScopedIdempotencyKey: (input: {
		userId: string
		parts: ReadonlyArray<string>
	}) => [input.userId, ...input.parts].join(':'),
	runWithDurableEscalation: (...args: Array<unknown>) =>
		mockModule.runWithDurableEscalation(...args),
}))

const { buildExternalPublishIdempotencyParts, publishExternalPushCapability } =
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
		external_check_until: null,
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
	mockModule.runWithDurableEscalation.mockImplementation(
		async (input: { run: (signal: AbortSignal) => Promise<unknown> }) => {
			const value = await input.run(new AbortController().signal)
			return { kind: 'completed', value }
		},
	)
}

function createContext(
	executionOrigin: 'interactive' | 'background' | 'omit' = 'interactive',
) {
	return {
		env: {
			APP_DB: {
				prepare(query: string) {
					return {
						bind() {
							return {
								first: async () => {
									if (query.includes('FROM workflow_runs')) return null
									return { username: 'user' }
								},
							}
						},
					}
				},
			},
			DYNAMIC_CALLABLE_WORKFLOWS: {},
		} as unknown as Env,
		callerContext: {
			baseUrl: 'https://kody.test',
			...(executionOrigin === 'omit' ? {} : { executionOrigin }),
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				username: 'user',
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
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalledTimes(1)

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
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalled()

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

test('ineligible publishes return structured results without durable escalation dispatch', async () => {
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'type error' }],
		manifest: {},
		run_id: 'run-1',
	})

	const failed = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)
	expect(failed).toEqual({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'type error' }],
		manifest: {},
		run_id: 'run-1',
	})
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalledTimes(1)
	const escalationInput = mockModule.runWithDurableEscalation.mock
		.calls[0]?.[0] as {
		userId: string
		idempotencyParts: ReadonlyArray<string>
	}
	// workflow_runs rows are scoped by acting userId; parts keep full semantic input.
	expect(escalationInput.userId).toBe('user-1')
	expect(escalationInput.idempotencyParts).toEqual(
		buildExternalPublishIdempotencyParts({
			ownerUserId: 'user-1',
			packageId: 'package-1',
			newCommit: 'commit-new',
			allowForce: false,
			destructiveOverwriteConfirmed: false,
		}),
	)
	expect(
		buildExternalPublishIdempotencyParts({
			ownerUserId: 'user-1',
			packageId: 'package-1',
			newCommit: 'commit-new',
			allowForce: true,
			destructiveOverwriteConfirmed: true,
		}),
	).not.toEqual(escalationInput.idempotencyParts)
})

test('missing executionOrigin fails closed and does not escalate', async () => {
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
		createContext('omit'),
	)
	expect(result.status).toBe('published')
	expect(mockModule.runWithDurableEscalation).not.toHaveBeenCalled()
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
})

test('budget exhaustion returns a dispatched handle and background re-entry skips escalation', async () => {
	setupDefaultMocks()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	const expectedParts = buildExternalPublishIdempotencyParts({
		ownerUserId: 'user-1',
		packageId: 'package-1',
		newCommit: 'commit-new',
		allowForce: false,
		destructiveOverwriteConfirmed: false,
	})
	mockModule.runWithDurableEscalation.mockResolvedValue({
		kind: 'dispatched',
		handle: {
			status: 'dispatched',
			workflow_id: 'dynwf-publish-1',
			workflow_name: 'package_publish_external_push',
			idempotency_key: ['user-1', ...expectedParts].join(':'),
			run_status: 'queued',
			message: 'dispatched',
		},
	})

	const dispatched = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext('interactive'),
	)
	expect(dispatched).toEqual({
		status: 'dispatched',
		workflow_id: 'dynwf-publish-1',
		workflow_name: 'package_publish_external_push',
		idempotency_key: ['user-1', ...expectedParts].join(':'),
		run_status: 'queued',
		message: 'dispatched',
	})
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			idempotencyParts: expectedParts,
		}),
	)

	mockModule.runWithDurableEscalation.mockClear()
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: {},
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	const background = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext('background'),
	)
	expect(background.status).toBe('published')
	expect(mockModule.runWithDurableEscalation).not.toHaveBeenCalled()
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
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
	// Each transient reset leaves exactly one retry warn trail (no Sentry).
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
			external_check_until: null,
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
			external_check_until: null,
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
	mockModule.publishFromExternalRef.mockClear()
	consoleWarn.mockClear()
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
	expect(consoleWarn).toHaveBeenCalledTimes(3)

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
