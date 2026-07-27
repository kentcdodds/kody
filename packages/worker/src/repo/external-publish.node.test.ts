import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(async () => true),
	runRepoChecks: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
	deletePublishedSourceSnapshot: vi.fn(async () => undefined),
	loadPublishedSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	refreshCommunityIconForPackagePublish: vi.fn(async () => undefined),
	hasPublishedRuntimeArtifacts: vi.fn(() => false),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('./checks.ts', () => ({
	runRepoChecks: (...args: Array<unknown>) => mockModule.runRepoChecks(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	hasPublishedRuntimeArtifacts: (...args: Array<unknown>) =>
		mockModule.hasPublishedRuntimeArtifacts(...args),
	loadPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.loadPublishedSourceSnapshot(...args),
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writePublishedSourceSnapshot(...args),
	deletePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.deletePublishedSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/community/community-icon.ts', () => ({
	refreshCommunityIconForPackagePublish: (...args: Array<unknown>) =>
		mockModule.refreshCommunityIconForPackagePublish(...args),
}))

const { publishFromExternalRef } = await import('./external-publish.ts')

function source(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-old',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
		...overrides,
	}
}

function workspace() {
	return {
		readFile: vi.fn(async () => '{}'),
		glob: vi.fn(async () => []),
	}
}

function resetPublishMocks() {
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.deletePublishedSourceSnapshot.mockResolvedValue(undefined)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		files: { 'package.json': '{}' },
	})
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(false)
}

test('publishes an external fast-forward ref after checks pass', async () => {
	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(source())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
	})

	const published = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
		isFastForward: async () => true,
		workspace: workspace(),
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
	})

	expect(published.status).toBe('published')
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-new',
		}),
	)
	// A successful package publish refreshes the community listing icon so
	// updated community-icon.* files become publicly visible without a
	// community republish.
	expect(mockModule.refreshCommunityIconForPackagePublish).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			packageId: 'package-1',
			publishedCommit: 'commit-new',
		}),
	)

	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(source())
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
		sourceFiles: {
			'package.json': '{"name":"@scope/demo"}',
			'src/index.ts': 'export default async () => null',
		},
	})

	const publishedWithRuntimeArtifacts = await publishFromExternalRef({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} as KVNamespace } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
		isFastForward: async () => true,
		workspace: workspace(),
		baseUrl: 'https://kody.test',
	})

	expect(publishedWithRuntimeArtifacts.status).toBe('published')
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: {
				'package.json': '{"name":"@scope/demo"}',
				'src/index.ts': 'export default async () => null',
			},
		}),
	)
})

test('returns no-op when commit is already current', async () => {
	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(source())

	await expect(
		publishFromExternalRef({
			env: { APP_DB: {} } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-old',
			isFastForward: async () => true,
			workspace: workspace(),
			files: {},
			baseUrl: 'https://kody.test',
		}),
	).resolves.toEqual({
		status: 'already_published',
		published_commit: 'commit-old',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	// Re-invoking after a partial/timed-out publish whose D1 published_commit
	// already matches the pushed HEAD must stay a no-op. This is what makes
	// overlapping inline + durable escalation safe: the second attempt cannot
	// double-apply checks or D1 writes.
	await expect(
		publishFromExternalRef({
			env: { APP_DB: {} } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-old',
			isFastForward: async () => {
				throw new Error('must not check ancestry when already published')
			},
			workspace: workspace(),
			files: {},
			baseUrl: 'https://kody.test',
		}),
	).resolves.toEqual({
		status: 'already_published',
		published_commit: 'commit-old',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('non-fast-forward publish requires allowForce, destructive confirmation, and a restorable backup snapshot', async () => {
	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(source())

	const refusedWithoutForce = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-rewritten',
		isFastForward: async () => false,
		workspace: workspace(),
		files: {},
		baseUrl: 'https://kody.test',
	})
	expect(refusedWithoutForce).toMatchObject({
		status: 'not_fast_forward',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewritten',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	await expect(
		publishFromExternalRef({
			env: { APP_DB: {} } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-rewritten',
			isFastForward: async () => false,
			allowForce: true,
			workspace: workspace(),
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('confirm_destructive_overwrite')

	mockModule.loadPublishedSourceSnapshot.mockResolvedValueOnce(null)
	await expect(
		publishFromExternalRef({
			env: { APP_DB: {} } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-rewritten',
			isFastForward: async () => false,
			allowForce: true,
			destructiveOverwriteConfirmed: true,
			workspace: workspace(),
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('Stop and report this source recovery problem')

	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
	})
	const published = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-rewritten',
		isFastForward: async () => false,
		allowForce: true,
		destructiveOverwriteConfirmed: true,
		workspace: workspace(),
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
	})
	expect(published).toEqual(
		expect.objectContaining({
			status: 'published',
			previous_commit: 'commit-old',
			published_commit: 'commit-rewritten',
		}),
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalledTimes(1)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-rewritten',
		}),
	)
})

test('rechecks fast-forward against the latest source row before publishing', async () => {
	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(
		source({ published_commit: 'commit-concurrent' }),
	)

	const result = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
		isFastForward: async (previousCommit) => previousCommit === 'commit-old',
		workspace: workspace(),
		files: {},
		baseUrl: 'https://kody.test',
	})

	expect(result).toMatchObject({
		status: 'not_fast_forward',
		previous_commit: 'commit-concurrent',
		published_commit: 'commit-new',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('check failure leaves D1 untouched', async () => {
	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(source())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [
			{ kind: 'manifest', ok: true, message: 'ok' },
			{ kind: 'typecheck', ok: false, message: 'bad type' },
		],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
	})

	const result = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
		isFastForward: async () => true,
		workspace: workspace(),
		files: {},
		baseUrl: 'https://kody.test',
		runId: 'run-1',
	})

	expect(result).toEqual({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad type' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
		run_id: 'run-1',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('publishFromExternalRef fails when projection refresh fails after commit', async () => {
	resetPublishMocks()
	mockModule.getEntitySourceById.mockResolvedValue(source())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
	})
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection failed'),
	)

	await expect(
		publishFromExternalRef({
			env: { APP_DB: {} } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-new',
			isFastForward: async () => true,
			workspace: workspace(),
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('projection failed')
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			publishedCommit: 'commit-new',
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			publishedCommit: 'commit-old',
		}),
	)
	// Failed publishes must not invalidate community icon caches.
	expect(
		mockModule.refreshCommunityIconForPackagePublish,
	).not.toHaveBeenCalled()

	mockModule.getEntitySourceById.mockResolvedValue(source())
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
	})
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection unavailable'),
	)

	await expect(
		publishFromExternalRef({
			env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} as KVNamespace } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-new',
			isFastForward: async () => true,
			workspace: workspace(),
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('projection unavailable')
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deletePublishedSourceSnapshot).toHaveBeenCalledWith({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} },
		sourceId: 'source-1',
		publishedCommit: 'commit-new',
	})
})
