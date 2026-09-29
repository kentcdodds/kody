import { expect, test, vi } from 'vitest'
import type * as PublishLock from '#worker/package-registry/package-publish-lock.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(async () => true),
	runRepoChecks: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
	deletePublishedSourceSnapshot: vi.fn(async () => undefined),
	loadPublishedSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	refreshCommunityIconForPackagePublish: vi.fn(async () => undefined),
	refreshIdentityIconForSource: vi.fn(async () => undefined),
	hasPublishedRuntimeArtifacts: vi.fn(() => false),
	loadLockedSavedPackage: vi.fn(async () => null),
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

vi.mock('#worker/repo/identity-icon.ts', () => ({
	refreshIdentityIconForSource: (...args: Array<unknown>) =>
		mockModule.refreshIdentityIconForSource(...args),
}))

vi.mock(
	'#worker/package-registry/package-publish-lock.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PublishLock>()
		return {
			...actual,
			loadLockedSavedPackage: (...args: Array<unknown>) =>
				mockModule.loadLockedSavedPackage(...args),
		}
	},
)

const { publishFromExternalRef } = await import('./external-publish.ts')

const manifest = {
	name: '@scope/demo',
	exports: { '.': './src/index.ts' },
	kody: { id: 'demo', description: 'Demo' },
}
const passingChecks = {
	ok: true,
	results: [{ kind: 'manifest', ok: true, message: 'ok' }],
	manifest,
}
const kvEnv = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} as KVNamespace } as Env

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
		external_check_until: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
		...overrides,
	}
}

function setupPublish(sourceOverrides: Record<string, unknown> = {}) {
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.deletePublishedSourceSnapshot.mockResolvedValue(undefined)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		files: { 'package.json': '{}' },
	})
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(false)
	mockModule.loadLockedSavedPackage.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue(source(sourceOverrides))
}

function publish(
	overrides: Partial<Parameters<typeof publishFromExternalRef>[0]> = {},
) {
	return publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
		isFastForward: async () => true,
		workspace: {
			readFile: vi.fn(async () => '{}'),
			glob: vi.fn(async () => []),
		},
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
		...overrides,
	})
}

test('publishes an external fast-forward ref after checks pass', async () => {
	setupPublish({ external_check_until: '2026-05-04T04:00:00.000Z' })
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	const phaseTimings = { clone_ms: 9 }

	const published = await publish({
		phaseTimings,
		deferBundleCheckToRebuild: true,
	})

	expect(published.status).toBe('published')
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ phaseTimings, deferBundleCheckToRebuild: true }),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-new',
			externalCheckUntil: null,
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
	expect(mockModule.refreshIdentityIconForSource).toHaveBeenCalledWith(
		expect.objectContaining({ iconCommit: 'commit-new', indexLiveHead: false }),
	)

	setupPublish()
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	const sourceFiles = {
		'package.json': '{"name":"@scope/demo"}',
		'src/index.ts': 'export default async () => null',
	}
	mockModule.runRepoChecks.mockResolvedValue({ ...passingChecks, sourceFiles })

	const withRuntimeArtifacts = await publish({ env: kvEnv, files: undefined })

	expect(withRuntimeArtifacts.status).toBe('published')
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ files: sourceFiles }),
	)
})

test('returns no-op when commit is already current', async () => {
	setupPublish()
	const alreadyPublished = {
		status: 'already_published',
		published_commit: 'commit-old',
	}

	await expect(
		publish({ newCommit: 'commit-old', files: {} }),
	).resolves.toEqual(alreadyPublished)
	// Re-invoking after a partial/timed-out publish whose D1 published_commit
	// already matches the pushed HEAD must stay a no-op. This is what makes
	// overlapping inline + durable escalation safe: the second attempt cannot
	// double-apply checks or D1 writes.
	await expect(
		publish({
			newCommit: 'commit-old',
			files: {},
			isFastForward: async () => {
				throw new Error('must not check ancestry when already published')
			},
		}),
	).resolves.toEqual(alreadyPublished)
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('non-fast-forward publish requires allowForce, destructive confirmation, and a restorable backup snapshot', async () => {
	setupPublish()
	const rewrite = {
		newCommit: 'commit-rewritten',
		isFastForward: async () => false,
	}

	await expect(publish({ ...rewrite, files: {} })).resolves.toMatchObject({
		status: 'not_fast_forward',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewritten',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	await expect(publish({ ...rewrite, allowForce: true })).rejects.toThrow(
		'confirm_destructive_overwrite',
	)

	const confirmed = {
		...rewrite,
		allowForce: true,
		destructiveOverwriteConfirmed: true,
	}
	mockModule.loadPublishedSourceSnapshot.mockResolvedValueOnce(null)
	await expect(publish(confirmed)).rejects.toThrow(
		'Stop and report this source recovery problem',
	)

	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	await expect(publish(confirmed)).resolves.toEqual(
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
	setupPublish({ published_commit: 'commit-concurrent' })

	await expect(
		publish({
			files: {},
			isFastForward: async (previousCommit) => previousCommit === 'commit-old',
		}),
	).resolves.toMatchObject({
		status: 'not_fast_forward',
		previous_commit: 'commit-concurrent',
		published_commit: 'commit-new',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('check failure leaves D1 untouched', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [
			{ kind: 'manifest', ok: true, message: 'ok' },
			{ kind: 'typecheck', ok: false, message: 'bad type' },
		],
		manifest,
	})

	await expect(publish({ files: {}, runId: 'run-1' })).resolves.toEqual({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad type' }],
		manifest,
		run_id: 'run-1',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('publishFromExternalRef fails when projection refresh fails after commit', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection failed'),
	)

	await expect(publish()).rejects.toThrow('projection failed')
	for (const publishedCommit of ['commit-new', 'commit-old']) {
		expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ publishedCommit }),
		)
	}
	// Failed publishes must not invalidate community icon caches.
	expect(
		mockModule.refreshCommunityIconForPackagePublish,
	).not.toHaveBeenCalled()

	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection unavailable'),
	)

	await expect(publish({ env: kvEnv })).rejects.toThrow(
		'projection unavailable',
	)
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deletePublishedSourceSnapshot).toHaveBeenCalledWith({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} },
		sourceId: 'source-1',
		publishedCommit: 'commit-new',
	})
})

test('locked package finishes checks then withholds published_commit unless allowLockedPublish', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	mockModule.loadLockedSavedPackage.mockResolvedValue({
		id: 'package-1',
		name: '@scope/demo',
		lockedAt: '2026-08-28T12:00:00.000Z',
	})

	await expect(
		publish({ deferBundleCheckToRebuild: true }),
	).resolves.toMatchObject({
		status: 'locked',
		previous_commit: 'commit-old',
		pending_commit: 'commit-new',
		packageId: 'package-1',
		packageName: '@scope/demo',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()
	expect(
		mockModule.runRepoChecks.mock.calls[0]?.[0]?.deferBundleCheckToRebuild,
	).toBeUndefined()

	mockModule.runRepoChecks.mockClear()
	const published = await publish({
		allowLockedPublish: true,
		deferBundleCheckToRebuild: true,
	})
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ deferBundleCheckToRebuild: true }),
	)
	expect(published.status).toBe('published')
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ id: 'source-1', publishedCommit: 'commit-new' }),
	)
})
