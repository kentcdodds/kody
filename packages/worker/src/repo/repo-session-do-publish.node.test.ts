import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	repoSessionMockModule as mockModule,
	restoreRepoSessionMockBaseline,
	createDurableObjectState,
	createEnv,
	setCommonSessionFixtures,
} from '#worker/test-support/repo-session-do.ts'

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<CloudflareWorkers>()
	return {
		...actual,
		DurableObject: class {
			protected readonly ctx: DurableObjectState
			protected readonly env: Env

			constructor(ctx: DurableObjectState, env: Env) {
				this.ctx = ctx
				this.env = env
			}
		},
	}
})

vi.mock('@cloudflare/shell', () => ({
	Workspace: class {
		constructor(_options: unknown) {}
		exists(path: string) {
			return mockModule.workspaceExists(path)
		}
		readFile(path: string) {
			return mockModule.workspaceReadFile(path)
		}
		writeFile(path: string, content: string) {
			return mockModule.workspaceWriteFile(path, content)
		}
		writeFileBytes(path: string, content: Uint8Array) {
			return mockModule.workspaceWriteFileBytes(path, content)
		}
		mkdir(path: string, options: unknown) {
			return mockModule.workspaceMkdir(path, options)
		}
		rm(path: string, options: unknown) {
			return mockModule.workspaceRm(path, options)
		}
		glob(pattern: string) {
			return mockModule.workspaceGlob(pattern)
		}
	},
	WorkspaceFileSystem: class {
		constructor(_workspace: unknown) {}
	},
	createWorkspaceStateBackend: vi.fn(() => ({
		// applyEditPlan persists caller-planned contents. Sequential same-path
		// composition is planned in Kody before this backend sees the batch.
		planEdits: vi.fn(
			async (
				instructions: Array<{ kind: string; path: string; content?: string }>,
			) => ({
				edits: instructions.map((instruction) => ({
					instruction,
					path: instruction.path,
					changed: true,
					content: instruction.content ?? '',
					diff: '',
				})),
				totalChanged: instructions.length,
				totalInstructions: instructions.length,
			}),
		),
		applyEditPlan: vi.fn(
			async (plan: {
				edits: Array<{ path: string; content: string; diff: string }>
				totalChanged: number
			}) => ({
				dryRun: false,
				totalChanged: plan.totalChanged,
				edits: plan.edits.map((edit) => ({
					path: edit.path,
					changed: true,
					content: edit.content,
					diff: edit.diff,
				})),
			}),
		),
		walkTree: vi.fn(),
	})),
}))

vi.mock('@cloudflare/shell/git', () => ({
	createGit: vi.fn(() => mockModule.git),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		push: (...args: Array<unknown>) => mockModule.rawPush(...args),
		readBlob: (...args: Array<unknown>) => mockModule.readBlob(...args),
	},
}))

vi.mock('isomorphic-git/http/web', () => ({
	default: {},
}))

vi.mock('./repo-sessions.ts', () => ({
	getRepoSessionById: (...args: Array<unknown>) =>
		mockModule.getRepoSessionById(...args),
	insertRepoSession: vi.fn(async () => undefined),
	updateRepoSession: (...args: Array<unknown>) =>
		mockModule.updateRepoSession(...args),
	deleteRepoSession: vi.fn(async () => undefined),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
	markEntitySourcePendingExternalReconcile: (...args: Array<unknown>) =>
		mockModule.markEntitySourcePendingExternalReconcile(...args),
}))

vi.mock('./artifacts.ts', async () => {
	const actual = await vi.importActual<Artifacts>('./artifacts.ts')
	return {
		...actual,
		resolveArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceRepo(...args),
		resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveExistingArtifactSourceRepo(...args),
		resolveArtifactDefaultBranchHead: (...args: Array<unknown>) =>
			mockModule.resolveArtifactDefaultBranchHead(...args),
		resolveArtifactSourceHead: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceHead(...args),
	}
})

vi.mock('./manifest.ts', () => ({
	parseRepoManifest: (...args: Array<unknown>) =>
		mockModule.parseRepoManifest(...args),
	normalizeRepoWorkspacePath: (path: string) => path.trim().replace(/^\/+/, ''),
}))

vi.mock('./checks.ts', () => ({
	runRepoChecks: (...args: Array<unknown>) => mockModule.runRepoChecks(...args),
	validatePackageBundles: (...args: Array<unknown>) =>
		mockModule.validatePackageBundles(...args),
	runPackageTypecheckLanguageService: (...args: Array<unknown>) =>
		mockModule.runPackageTypecheckLanguageService(...args),
}))

vi.mock('./external-publish-clone.ts', () => ({
	externalPublishWorkspaceDir: '/repo',
	isWorkspaceSqliteTooBigMessage: (message: string) =>
		message.includes('SQLITE_TOOBIG') ||
		/string or blob too big/i.test(message),
	buildWorkspaceSqliteTooBigCallerMessage: (operation: string) =>
		`${operation} failed because a git object exceeded the Durable Object SQLite 2 MiB row limit`,
	cloneExternalPublishWorkspace: (...args: Array<unknown>) =>
		mockModule.cloneExternalPublishWorkspace(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<PublishedRuntimeArtifacts>(
		'#worker/package-runtime/published-runtime-artifacts.ts',
	)
	return {
		...actual,
		writePublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.writePublishedSourceSnapshot(...args),
		loadPublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.loadPublishedSourceSnapshot(...args),
		loadPublishedSourceManifestSnapshot: (...args: Array<unknown>) =>
			mockModule.loadPublishedSourceManifestSnapshot(...args),
	}
})

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'#worker/package-runtime/published-bundle-artifacts.ts',
	)
	return {
		...actual,
		isPublishedPackageArtifactBuiltForCommit: (...args: Array<unknown>) =>
			mockModule.isPublishedPackageArtifactBuiltForCommit(...args),
		persistPublishedPackageArtifactTarget: (...args: Array<unknown>) =>
			mockModule.persistPublishedPackageArtifactTarget(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	deleteStorageBucketInventory: (...args: Array<unknown>) =>
		mockModule.deleteStorageBucketInventory(...args),
	maybeRefreshStorageBucketEstimate: (...args: Array<unknown>) =>
		mockModule.maybeRefreshStorageBucketEstimate(...args),
	registerStorageBucketAndWait: (...args: Array<unknown>) =>
		mockModule.registerStorageBucketAndWait(...args),
	repoSessionStorageBucketId: (sessionId: string) =>
		`repo-session:${sessionId}`,
}))

const { RepoSession } = await import('./repo-session-do.ts')

test('publishSession persists the workspace snapshot to BUNDLE_ARTIFACTS_KV so downstream readers find the freshly published commit', async () => {
	// Best-effort publish git-note attachment logs an incidental warning.
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-published-new'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.writePublishedSourceSnapshot.mockClear()
	// Include the manifest file (kody.json per setCommonSessionFixtures) so
	// the assertion mirrors the real writePublishedSourceSnapshot contract,
	// which requires the manifest_path entry to be present in files.
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/kody.json' },
		{ type: 'file', path: '/session/package.json' },
		{ type: 'file', path: '/session/src/index.ts' },
		{ type: 'file', path: '/session/.git/config' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/kody.json') {
			return '{"version":1,"kind":"job","entrypoint":"src/job.ts"}'
		}
		if (path === '/session/package.json') {
			return '{"name":"demo","kody":{"id":"demo"}}'
		}
		if (path === '/session/src/index.ts') {
			return 'export default {}'
		}
		return ''
	})

	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as unknown as KVNamespace,
	} as Env
	const repoSession = new RepoSession(createDurableObjectState(), env)

	await repoSession.publishSession({
		sessionId: 'session-1',
		userId: 'user-1',
		force: true,
	})

	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledTimes(1)
	const snapshotCall = mockModule.writePublishedSourceSnapshot.mock.calls[0][0]
	expect(snapshotCall.source.id).toBe('source-1')
	expect(snapshotCall.source.published_commit).toBe('commit-published-new')
	expect(snapshotCall.files).toEqual({
		'kody.json': '{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
		'package.json': '{"name":"demo","kody":{"id":"demo"}}',
		'src/index.ts': 'export default {}',
	})
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-published-new',
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('publish_git_note'),
		expect.anything(),
	)
})

test('publishSession handles snapshot collection and persistence failures without leaving inconsistent published commits', async () => {
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as unknown as KVNamespace,
	} as Env

	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-published-fail'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.writePublishedSourceSnapshot.mockReset()
	mockModule.writePublishedSourceSnapshot.mockRejectedValueOnce(
		new Error('kv write failed'),
	)
	mockModule.updateEntitySource.mockClear()
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/kody.json' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	mockModule.workspaceReadFile.mockResolvedValue(
		'{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
	)

	await expect(
		new RepoSession(createDurableObjectState(), env).publishSession({
			sessionId: 'session-1',
			userId: 'user-1',
			force: true,
		}),
	).rejects.toThrow('kv write failed')
	expect(mockModule.updateEntitySource).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-published-fail',
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-base',
		}),
	)

	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-published-double-fail'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.writePublishedSourceSnapshot.mockReset()
	mockModule.writePublishedSourceSnapshot.mockRejectedValueOnce(
		new Error('kv write failed'),
	)
	mockModule.updateEntitySource.mockReset()
	mockModule.updateEntitySource
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new Error('d1 revert failed'))
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/kody.json' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	mockModule.workspaceReadFile.mockResolvedValue(
		'{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
	)

	await expect(
		new RepoSession(createDurableObjectState(), env).publishSession({
			sessionId: 'session-1',
			userId: 'user-1',
			force: true,
		}),
	).rejects.toThrow('kv write failed')
	expect(mockModule.updateEntitySource).toHaveBeenCalledTimes(2)

	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-published-collect-fail'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.writePublishedSourceSnapshot.mockReset()
	mockModule.updateEntitySource.mockClear()
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/kody.json' },
		{ type: 'file', path: '/session/src/index.ts' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/kody.json') {
			return '{"version":1,"kind":"job","entrypoint":"src/job.ts"}'
		}
		return null
	})

	await expect(
		new RepoSession(createDurableObjectState(), env).publishSession({
			sessionId: 'session-1',
			userId: 'user-1',
			force: true,
		}),
	).rejects.toThrow(/Failed to read repo session file/)
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('publishFromExternalRef rejects stale expected HEAD values', async () => {
	setCommonSessionFixtures()
	// Clone tip is the remote default-branch HEAD at clone time; a mismatch
	// with expectedHead means the Artifacts tip moved.
	mockModule.cloneExternalPublishWorkspace.mockResolvedValueOnce({
		workspace: {
			readFile: vi.fn(async () => null),
			glob: vi.fn(async () => []),
		},
		headCommit: 'commit-new',
		dir: '/repo',
		filesystem: {
			readFile: vi.fn(async () => ''),
			readFileBytes: vi.fn(async () => new Uint8Array()),
			writeFile: vi.fn(async () => undefined),
			writeFileBytes: vi.fn(async () => undefined),
			rm: vi.fn(async () => undefined),
			mkdir: vi.fn(async () => undefined),
			readdir: vi.fn(async () => []),
			stat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			lstat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			readlink: vi.fn(async () => ''),
			symlink: vi.fn(async () => undefined),
		},
		isAncestorCommit: vi.fn(async () => true),
	})

	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await expect(
		repoSession.publishFromExternalRef({
			sessionId: 'external-publish-source-1',
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-stale',
			expectedHead: 'commit-stale',
		}),
	).rejects.toThrow(
		'Artifacts HEAD changed from "commit-stale" to "commit-new" before publish.',
	)
	expect(mockModule.resolveArtifactDefaultBranchHead).not.toHaveBeenCalled()
})

test('publishFromExternalRef checks fast-forward ancestry through ephemeral clone', async () => {
	// Best-effort publish git-note setup logs an incidental warning.
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'source-repo',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		source_root: '/',
		entity_kind: 'job',
		entity_id: 'job-1',
	})
	const isAncestorCommit = vi.fn(async ({ ancestor, descendant }) => {
		return ancestor === 'commit-old' && descendant === 'commit-new'
	})
	mockModule.cloneExternalPublishWorkspace.mockResolvedValueOnce({
		workspace: {
			readFile: vi.fn(async () => null),
			glob: vi.fn(async () => []),
		},
		headCommit: 'commit-new',
		dir: '/repo',
		filesystem: {
			readFile: vi.fn(async () => ''),
			readFileBytes: vi.fn(async () => new Uint8Array()),
			writeFile: vi.fn(async () => undefined),
			writeFileBytes: vi.fn(async () => undefined),
			rm: vi.fn(async () => undefined),
			mkdir: vi.fn(async () => undefined),
			readdir: vi.fn(async () => []),
			stat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			lstat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			readlink: vi.fn(async () => ''),
			symlink: vi.fn(async () => undefined),
		},
		isAncestorCommit,
	})
	mockModule.writePublishedSourceSnapshot.mockClear()

	const repoSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	} as Env)

	const result = await repoSession.publishFromExternalRef({
		sessionId: 'external-publish-source-1',
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
	})

	expect(result.status).toBe('published')
	expect(mockModule.workspaceGlob).not.toHaveBeenCalled()
	expect(isAncestorCommit).toHaveBeenCalledWith({
		ancestor: 'commit-old',
		descendant: 'commit-new',
	})
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			publishedCommit: 'commit-new',
		}),
	)
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: {
				'package.json': '{"name":"@kody/demo"}',
				'index.ts': 'export const ready = true\n',
			},
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'publish_git_note failed',
		expect.objectContaining({
			scope: 'repo.publishFromExternalRef.publish-git-note',
		}),
	)
})

test('runIsolatedCheckPhase loads staged files from KV and dispatches the phase', async () => {
	const staged = {
		sourceFiles: { 'package.json': '{"name":"@kody/demo"}' },
	}
	const kv = {
		get: vi.fn(async () => staged),
	}
	const session = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env)

	const bundleOutcome = await session.runIsolatedCheckPhase({
		phase: 'bundle-chunk',
		stagingKey: 'repo-checks-staging:v1:user-1:abc',
		baseUrl: '/',
		userId: 'user-1',
		bundleTargets: [{ path: 'src/index.ts', bundleKind: 'callable' }],
	})
	expect(bundleOutcome.ok).toBe(true)
	expect(mockModule.validatePackageBundles).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			sourceFiles: staged.sourceFiles,
			entryPoints: [{ path: 'src/index.ts', bundleKind: 'callable' }],
		}),
	)

	const typecheckOutcome = await session.runIsolatedCheckPhase({
		phase: 'typecheck',
		stagingKey: 'repo-checks-staging:v1:user-1:abc',
		userId: 'user-1',
		typecheckTargets: [
			{ path: 'src/index.ts', includeStorage: false, emittedEventTopics: [] },
		],
	})
	expect(typecheckOutcome.ok).toBe(true)
	expect(mockModule.runPackageTypecheckLanguageService).toHaveBeenCalledWith({
		sourceFiles: staged.sourceFiles,
		targets: [
			{ path: 'src/index.ts', includeStorage: false, emittedEventTopics: [] },
		],
	})

	// Expired staging fails closed with an actionable message.
	kv.get.mockResolvedValueOnce(null)
	const expired = await session.runIsolatedCheckPhase({
		phase: 'typecheck',
		stagingKey: 'repo-checks-staging:v1:user-1:gone',
		userId: 'user-1',
		typecheckTargets: [],
	})
	expect(expired.ok).toBe(false)
	expect(expired.message).toContain('staging data expired')

	// A staging key namespaced to another user is rejected before any read.
	kv.get.mockClear()
	const crossUser = await session.runIsolatedCheckPhase({
		phase: 'typecheck',
		stagingKey: 'repo-checks-staging:v1:user-2:abc',
		userId: 'user-1',
		typecheckTargets: [],
	})
	expect(crossUser.ok).toBe(false)
	expect(crossUser.message).toContain('does not belong to the requesting user')
	expect(kv.get).not.toHaveBeenCalled()
})

test('runIsolatedArtifactRebuild loads staged files, skips built targets, and rejects cross-user keys', async () => {
	restoreRepoSessionMockBaseline()
	const staged = {
		sourceFiles: {
			'package.json':
				'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}',
			'index.ts': 'export const ready = true\n',
		},
	}
	const kv = {
		get: vi.fn(async () => staged),
		put: vi.fn(async () => undefined),
	}
	const packageSource = {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
	mockModule.getEntitySourceById.mockResolvedValue(packageSource)
	const session = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env)
	const target = {
		kind: 'module' as const,
		artifactName: '.',
		entryPoint: 'index.ts',
		bundleKind: 'module' as const,
	}

	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValueOnce(
		true,
	)
	const skipped = await session.runIsolatedArtifactRebuild({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:abc',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
	})
	expect(skipped).toMatchObject({ ok: true, skipped: true })
	expect(kv.get).not.toHaveBeenCalled()
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).not.toHaveBeenCalled()

	const forced = await session.runIsolatedArtifactRebuild({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:abc',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
		baseUrl: 'https://kody.test',
		force: true,
	})
	expect(forced).toMatchObject({
		ok: true,
		kvKey: 'kv:artifact',
		target,
	})
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).toHaveBeenCalledTimes(1)

	const rebuilt = await session.runIsolatedArtifactRebuild({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:abc',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
		baseUrl: 'https://kody.test',
	})
	expect(rebuilt).toMatchObject({
		ok: true,
		kvKey: 'kv:artifact',
		target,
	})
	expect(mockModule.persistPublishedPackageArtifactTarget).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			target,
			source: expect.objectContaining({ published_commit: 'commit-1' }),
		}),
	)

	kv.get.mockResolvedValueOnce(null)
	const expired = await session.runIsolatedArtifactRebuild({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:gone',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
	})
	expect(expired.ok).toBe(false)
	expect(expired.message).toContain('staging data expired')

	kv.get.mockClear()
	const crossUser = await session.runIsolatedArtifactRebuild({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-2:abc',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
	})
	expect(crossUser.ok).toBe(false)
	expect(crossUser.message).toContain('does not belong to the requesting user')
	expect(kv.get).not.toHaveBeenCalled()
})

test('stagePublishedPackageArtifactRebuild collects workspace files once and stages them', async () => {
	restoreRepoSessionMockBaseline()
	const packageJson =
		'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}'
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/package.json' },
		{ type: 'file', path: '/session/index.ts' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/package.json') return packageJson
		if (path === '/session/index.ts') return 'export const ready = true\n'
		return null
	})
	const packageSource = {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
	mockModule.getEntitySourceById.mockResolvedValue(packageSource)

	const put = vi.fn(async () => undefined)
	const session = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: { put },
	} as unknown as Env)

	const staged = await session.stagePublishedPackageArtifactRebuild({
		sourceId: 'source-1',
		userId: 'user-1',
	})
	expect(
		staged.stagingKey.startsWith('repo-artifact-rebuild-staging:v1:user-1:'),
	).toBe(true)
	expect(put).toHaveBeenCalledTimes(1)
	expect(put).toHaveBeenCalledWith(
		staged.stagingKey,
		expect.stringContaining('"package.json"'),
		{ expirationTtl: 15 * 60 },
	)
	const payload = JSON.parse(put.mock.calls[0]?.[1] as string) as {
		sourceFiles: Record<string, string>
	}
	expect(payload.sourceFiles).toEqual({
		'package.json': packageJson,
		'index.ts': 'export const ready = true\n',
	})
	expect(mockModule.workspaceGlob).toHaveBeenCalledTimes(1)
})

test('published artifact rebuild falls back to the published snapshot when the session workspace is empty', async () => {
	restoreRepoSessionMockBaseline()
	const packageJson =
		'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}'
	const snapshotFiles = {
		'package.json': packageJson,
		'index.ts': 'export const ready = true\n',
	}
	const packageSource = {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}

	mockModule.workspaceReadFile.mockResolvedValue(null)
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		manifestContent: packageJson,
		createdAt: '2026-08-17T20:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValue(packageSource)

	const listSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
	} as unknown as Env)
	await expect(
		listSession.listPublishedPackageArtifactTargets({
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	).resolves.toEqual([
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'index.ts',
			bundleKind: 'module',
		},
		{
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'index.ts',
			bundleKind: 'importable-module',
		},
	])
	expect(mockModule.loadPublishedSourceManifestSnapshot).toHaveBeenCalledTimes(
		1,
	)

	restoreRepoSessionMockBaseline()
	mockModule.workspaceGlob.mockResolvedValue([])
	mockModule.workspaceReadFile.mockResolvedValue(null)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		repoId: 'package-package-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files: snapshotFiles,
		createdAt: '2026-08-17T20:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValue(packageSource)

	const put = vi.fn(async () => undefined)
	const stageSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: { put },
	} as unknown as Env)
	const staged = await stageSession.stagePublishedPackageArtifactRebuild({
		sourceId: 'source-1',
		userId: 'user-1',
	})
	const payload = JSON.parse(put.mock.calls[0]?.[1] as string) as {
		sourceFiles: Record<string, string>
	}
	expect(payload.sourceFiles).toEqual(snapshotFiles)
	expect(mockModule.loadPublishedSourceSnapshot).toHaveBeenCalledTimes(1)
	expect(
		staged.stagingKey.startsWith('repo-artifact-rebuild-staging:v1:user-1:'),
	).toBe(true)
})

test('published artifact rebuild prefers the published snapshot over a leftover session workspace', async () => {
	restoreRepoSessionMockBaseline()
	const snapshotFiles = {
		'package.json':
			'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}',
		'index.ts': 'export const fromSnapshot = true\n',
	}
	const packageSource = {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/package.json' },
		{ type: 'file', path: '/session/index.ts' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/package.json') {
			return '{"name":"@kody/stale","exports":{".":"./index.ts"},"kody":{"id":"stale","description":"Stale"}}'
		}
		if (path === '/session/index.ts')
			return 'export const fromWorkspace = true\n'
		return null
	})
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		manifestContent: snapshotFiles['package.json'],
		createdAt: '2026-08-19T15:00:00.000Z',
	})
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		repoId: 'package-package-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files: snapshotFiles,
		createdAt: '2026-08-19T15:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValue(packageSource)

	const listSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
	} as unknown as Env)
	await expect(
		listSession.listPublishedPackageArtifactTargets({
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	).resolves.toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'module',
				artifactName: '.',
				entryPoint: 'index.ts',
			}),
		]),
	)
	expect(mockModule.loadPublishedSourceManifestSnapshot).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.workspaceReadFile).not.toHaveBeenCalled()

	const put = vi.fn(async () => undefined)
	const stageSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: { put },
	} as unknown as Env)
	await stageSession.stagePublishedPackageArtifactRebuild({
		sourceId: 'source-1',
		userId: 'user-1',
	})
	const payload = JSON.parse(put.mock.calls[0]?.[1] as string) as {
		sourceFiles: Record<string, string>
	}
	expect(payload.sourceFiles).toEqual(snapshotFiles)
	expect(mockModule.workspaceGlob).not.toHaveBeenCalled()
})

test('already_published external publish refreshes the snapshot from the in-memory clone', async () => {
	restoreRepoSessionMockBaseline()
	setCommonSessionFixtures()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'source-repo',
		published_commit: 'commit-new',
		manifest_path: 'package.json',
		source_root: '/',
		entity_kind: 'package',
		entity_id: 'package-1',
	})
	const cloneFiles = {
		'package.json':
			'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}',
		'index.ts': 'export const fromClone = true\n',
	}
	const collectFiles = vi.fn(async () => cloneFiles)
	mockModule.cloneExternalPublishWorkspace.mockResolvedValueOnce({
		workspace: {
			readFile: vi.fn(async () => null),
			glob: vi.fn(async () => []),
		},
		headCommit: 'commit-new',
		dir: '/repo',
		filesystem: {
			readFile: vi.fn(async () => ''),
			readFileBytes: vi.fn(async () => new Uint8Array()),
			writeFile: vi.fn(async () => undefined),
			writeFileBytes: vi.fn(async () => undefined),
			rm: vi.fn(async () => undefined),
			mkdir: vi.fn(async () => undefined),
			readdir: vi.fn(async () => []),
			stat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			lstat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			readlink: vi.fn(async () => ''),
			symlink: vi.fn(async () => undefined),
		},
		isAncestorCommit: vi.fn(async () => true),
		collectFiles,
	})
	mockModule.writePublishedSourceSnapshot.mockClear()

	const repoSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	} as Env)
	const result = await repoSession.publishFromExternalRef({
		sessionId: 'external-publish-source-1',
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'commit-new',
	})

	expect(result).toEqual({
		status: 'already_published',
		published_commit: 'commit-new',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(collectFiles).toHaveBeenCalledTimes(1)
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			source: expect.objectContaining({ published_commit: 'commit-new' }),
			files: cloneFiles,
		}),
	)
})

test('already_published external publish fails when snapshot refresh fails', async () => {
	restoreRepoSessionMockBaseline()
	setCommonSessionFixtures()
	consoleWarn.mockImplementation(() => {})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'source-repo',
		published_commit: 'commit-new',
		manifest_path: 'package.json',
		source_root: '/',
		entity_kind: 'package',
		entity_id: 'package-1',
	})
	mockModule.cloneExternalPublishWorkspace.mockResolvedValueOnce({
		workspace: {
			readFile: vi.fn(async () => null),
			glob: vi.fn(async () => []),
		},
		headCommit: 'commit-new',
		dir: '/repo',
		filesystem: {
			readFile: vi.fn(async () => ''),
			readFileBytes: vi.fn(async () => new Uint8Array()),
			writeFile: vi.fn(async () => undefined),
			writeFileBytes: vi.fn(async () => undefined),
			rm: vi.fn(async () => undefined),
			mkdir: vi.fn(async () => undefined),
			readdir: vi.fn(async () => []),
			stat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			lstat: vi.fn(async () => ({
				type: 'file' as const,
				size: 0,
				mtime: new Date(),
			})),
			readlink: vi.fn(async () => ''),
			symlink: vi.fn(async () => undefined),
		},
		isAncestorCommit: vi.fn(async () => true),
		collectFiles: vi.fn(async () => {
			throw new Error('clone files unreadable')
		}),
	})

	const repoSession = new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	} as Env)
	await expect(
		repoSession.publishFromExternalRef({
			sessionId: 'external-publish-source-1',
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-new',
		}),
	).rejects.toThrow('clone files unreadable')
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'already_published snapshot refresh failed',
		expect.objectContaining({
			scope: 'repo.publishFromExternalRef.refresh-already-published-snapshot',
		}),
	)
})

test('publishSession maps non-fast-forward PushRejectedError to base_moved without force', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.rawPush.mockRejectedValueOnce(
		Object.assign(
			new Error(
				'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
			),
			{ name: 'PushRejectedError', code: 'PushRejectedError' },
		),
	)
	const state = createDurableObjectState()
	// Empty workspace → SHA-256 of '' so checks are not stale without force.
	await state.storage.put('repo-session:last-check-status', {
		runId: 'run-1',
		treeHash:
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		checkedAt: '2026-04-18T00:00:00.000Z',
		ok: true,
		results: [],
	})
	const repoSession = new RepoSession(state, createEnv())

	// Post-rejection tip refresh (precheck uses D1 published_commit only).
	mockModule.resolveArtifactSourceHead.mockClear()
	mockModule.resolveArtifactSourceHead.mockResolvedValueOnce({
		branch: 'main',
		commit: 'commit-published-new',
	})

	const result = await repoSession.publishSession({
		sessionId: 'session-1',
		userId: 'user-1',
	})
	expect(result).toEqual({
		status: 'base_moved',
		sessionId: 'session-1',
		publishedCommit: null,
		sessionBaseCommit: 'commit-base',
		currentPublishedCommit: 'commit-published-new',
		repairHint: 'repo_rebase_session',
		message:
			'The source repo rejected a non-fast-forward publish. Rebase the session before publishing.',
	})
	expect(mockModule.resolveArtifactSourceHead).toHaveBeenCalledTimes(1)
	expect(mockModule.resolveArtifactSourceHead).toHaveBeenCalledWith(
		expect.anything(),
		'source-repo',
	)
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'sessions/session1',
			force: true,
		}),
	)
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.not.objectContaining({ force: true }),
	)
})

test('runChecks forwards expectedPackageScope for a still-plain repo so promote can run package checks', async () => {
	setCommonSessionFixtures()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'repo',
		entity_id: 'repo-1',
		repo_id: 'source-repo',
		published_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
	})
	mockModule.runRepoChecks.mockClear()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())
	const result = await repoSession.runChecks({
		sessionId: 'session-1',
		userId: 'user-1',
		expectedPackageScope: 'user',
	})
	expect(result.ok).toBe(true)
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedPackageScope: 'user',
		}),
	)
})
