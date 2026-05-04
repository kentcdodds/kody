import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(async () => true),
	runRepoChecks: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
	refreshSavedPackageProjection: vi.fn(),
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
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writePublishedSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

const { publishFromExternalRef } = await import('./external-publish.ts')
const { finalizePublishedEntitySource } = await import('./external-publish.ts')

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

beforeEach(() => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockClear()
	mockModule.runRepoChecks.mockReset()
	mockModule.writePublishedSourceSnapshot.mockClear()
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(false)
	mockModule.refreshSavedPackageProjection.mockClear()
})

test('publishes an external fast-forward ref after checks pass', async () => {
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

	const result = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
		isFastForward: true,
		workspace: workspace(),
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
	})

	expect(result.status).toBe('published')
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-new',
		}),
	)
})

test('returns no-op when commit is already current', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(source())

	await expect(
		publishFromExternalRef({
			env: { APP_DB: {} } as Env,
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-old',
			isFastForward: true,
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

test('refuses non-fast-forward publish unless allowForce is true', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(source())

	const result = await publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-rewritten',
		isFastForward: false,
		workspace: workspace(),
		files: {},
		baseUrl: 'https://kody.test',
	})

	expect(result).toEqual({
		status: 'not_fast_forward',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewritten',
		message:
			'The external Artifacts HEAD is not a descendant of the current published commit. Retry with allow_force to publish it.',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('check failure leaves D1 untouched', async () => {
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
		isFastForward: true,
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
