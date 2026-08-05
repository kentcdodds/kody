import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'

const mockModule = vi.hoisted(() => {
	const gitState = {
		currentBranch: 'main',
		headCommit: 'commit-head',
		statusEntries: [] as Array<{ status: string }>,
		remotes: [] as Array<{ remote: string; url: string }>,
	}

	const git = {
		clone: vi.fn(async () => ({ cloned: 'ok', dir: '/session' })),
		remote: vi.fn(
			async (opts?: {
				list?: boolean
				add?: { name: string; url: string }
				remove?: string
			}) => {
				if (opts?.list) {
					return gitState.remotes
				}
				if (opts?.remove) {
					gitState.remotes = gitState.remotes.filter(
						(remote) => remote.remote !== opts.remove,
					)
					return { removed: opts.remove }
				}
				if (opts?.add) {
					gitState.remotes = [
						...gitState.remotes.filter(
							(remote) => remote.remote !== opts.add?.name,
						),
						{ remote: opts.add.name, url: opts.add.url },
					]
					return { added: opts.add.name, url: opts.add.url }
				}
				return []
			},
		),
		init: vi.fn(async () => ({ initialized: '/session' })),
		status: vi.fn(async () => gitState.statusEntries),
		add: vi.fn(async () => ({ added: '.' })),
		rm: vi.fn(async () => ({ removed: 'src/old.ts' })),
		commit: vi.fn(async () => ({
			oid: gitState.headCommit,
			message: 'commit',
		})),
		log: vi.fn(async () => [{ oid: gitState.headCommit }]),
		branch: vi.fn(async () => ({
			branches: [gitState.currentBranch],
			current: gitState.currentBranch,
		})),
		checkout: vi.fn(async () => ({ ref: gitState.currentBranch })),
		fetch: vi.fn(async () => ({
			fetchHead: gitState.headCommit,
			fetchHeadDescription: 'main',
		})),
		pull: vi.fn(async () => ({ pulled: true })),
		push: vi.fn(async () => ({ ok: true, refs: {} })),
		diff: vi.fn(async () => []),
	}

	return {
		git,
		gitState,
		rawPush: vi.fn(async () => ({ ok: true, refs: {} })),
		readBlob: vi.fn(async () => ({
			blob: new TextEncoder().encode('restored content\n'),
		})),
		workspaceExists: vi.fn(
			async (path: string) => path === '/session/.git/config',
		),
		workspaceFiles: new Map<string, string>(),
		workspaceReadFile: vi.fn(
			async (path: string) =>
				mockModule.workspaceFiles.get(path) ??
				'{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
		),
		workspaceWriteFile: vi.fn(async () => undefined),
		workspaceWriteFileBytes: vi.fn(async () => undefined),
		workspaceMkdir: vi.fn(async () => undefined),
		workspaceRm: vi.fn(async () => undefined),
		workspaceGlob: vi.fn(async () => []),
		storageGet: vi.fn(async () => ({
			runId: 'run-1',
			treeHash: '',
			checkedAt: '2026-04-18T00:00:00.000Z',
			ok: true,
			results: [],
		})),
		storagePut: vi.fn(async () => undefined),
		getRepoSessionById: vi.fn(),
		getEntitySourceById: vi.fn(),
		updateRepoSession: vi.fn(async () => undefined),
		updateEntitySource: vi.fn(async () => undefined),
		markEntitySourcePendingExternalReconcile: vi.fn(async () => true),
		resolveArtifactSourceRepo: vi.fn(),
		resolveExistingArtifactSourceRepo: vi.fn(),
		resolveArtifactDefaultBranchHead: vi.fn(async () => ({
			defaultBranch: 'main',
			commit: 'commit-published-new',
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		})),
		parseRepoManifest: vi.fn(() => ({ sourceRoot: '/' })),
		runRepoChecks: vi.fn(async () => ({
			ok: true,
			results: [{ kind: 'manifest', ok: true, message: 'Manifest ok' }],
			manifest: {
				name: '@kody/demo',
				exports: { '.': './index.ts' },
				kody: { id: 'demo', description: 'Demo package' },
			},
			sourceFiles: {
				'package.json': '{"name":"@kody/demo"}',
				'index.ts': 'export const ready = true\n',
			},
		})),
		writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
		validatePackageBundles: vi.fn(async () => ({
			ok: true,
			message: 'Bundled 2 package target(s) successfully.',
		})),
		runPackageTypecheckLanguageService: vi.fn(async () => ({
			ok: true,
			message:
				'No semantic diagnostics for 1 callable package runtime entrypoint(s).',
		})),
		isPublishedPackageArtifactBuiltForCommit: vi.fn(async () => false),
		persistPublishedPackageArtifactTarget: vi.fn(async () => 'kv:artifact'),
		registerStorageBucketAndWait: vi.fn(async () => undefined),
		maybeRefreshStorageBucketEstimate: vi.fn(),
		deleteStorageBucketInventory: vi.fn(async () => true),
		getSavedPackageById: vi.fn(async () => ({
			id: 'package-1',
			kodyId: 'demo',
			sourceId: 'source-1',
		})),
	}
})

function restoreRepoSessionMockBaseline() {
	const { git, gitState } = mockModule

	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.workspaceReadFile.mockImplementation(
		async (path: string) =>
			mockModule.workspaceFiles.get(path) ??
			'{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
	)
	mockModule.workspaceWriteFile.mockResolvedValue(undefined)
	mockModule.workspaceWriteFileBytes.mockResolvedValue(undefined)
	mockModule.workspaceMkdir.mockResolvedValue(undefined)
	mockModule.workspaceRm.mockResolvedValue(undefined)
	mockModule.workspaceGlob.mockResolvedValue([])
	mockModule.storageGet.mockResolvedValue({
		runId: 'run-1',
		treeHash: '',
		checkedAt: '2026-04-18T00:00:00.000Z',
		ok: true,
		results: [],
	})
	mockModule.storagePut.mockResolvedValue(undefined)
	mockModule.updateRepoSession.mockResolvedValue(undefined)
	mockModule.updateEntitySource.mockResolvedValue(undefined)
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			id: 'source-repo-id',
			name: 'source-repo',
			description: null,
			defaultBranch: 'main',
			createdAt: '2026-04-16T00:00:00.000Z',
			updatedAt: '2026-04-16T00:00:00.000Z',
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		})),
		createToken: vi.fn(async () => ({
			id: 'token-source',
			plaintext: 'art_source_secret?expires=1760000200',
			scope: 'write',
			expiresAt: '2026-10-09T08:16:40.000Z',
		})),
	})
	mockModule.resolveArtifactDefaultBranchHead.mockResolvedValue({
		defaultBranch: 'main',
		commit: 'commit-published-new',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
	})
	mockModule.parseRepoManifest.mockReturnValue({ sourceRoot: '/' })
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Manifest ok' }],
		manifest: {
			name: '@kody/demo',
			exports: { '.': './index.ts' },
			kody: { id: 'demo', description: 'Demo package' },
		},
		sourceFiles: {
			'package.json': '{"name":"@kody/demo"}',
			'index.ts': 'export const ready = true\n',
		},
	})
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)
	mockModule.persistPublishedPackageArtifactTarget.mockResolvedValue(
		'kv:artifact',
	)
	mockModule.registerStorageBucketAndWait.mockClear()
	mockModule.maybeRefreshStorageBucketEstimate.mockClear()
	mockModule.deleteStorageBucketInventory.mockClear()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'demo',
		sourceId: 'source-1',
	})
	mockModule.rawPush.mockResolvedValue({ ok: true, refs: {} })
	mockModule.rawPush.mockClear()

	git.clone.mockResolvedValue({ cloned: 'ok', dir: '/session' })
	git.remote.mockImplementation(
		async (opts?: {
			list?: boolean
			add?: { name: string; url: string }
			remove?: string
		}) => {
			if (opts?.list) {
				return gitState.remotes
			}
			if (opts?.remove) {
				gitState.remotes = gitState.remotes.filter(
					(remote) => remote.remote !== opts.remove,
				)
				return { removed: opts.remove }
			}
			if (opts?.add) {
				gitState.remotes = [
					...gitState.remotes.filter(
						(remote) => remote.remote !== opts.add?.name,
					),
					{ remote: opts.add.name, url: opts.add.url },
				]
				return { added: opts.add.name, url: opts.add.url }
			}
			return []
		},
	)
	git.init.mockResolvedValue({ initialized: '/session' })
	git.status.mockImplementation(async () => gitState.statusEntries)
	git.add.mockResolvedValue({ added: '.' })
	git.rm.mockResolvedValue({ removed: 'src/old.ts' })
	git.commit.mockImplementation(async () => ({
		oid: gitState.headCommit,
		message: 'commit',
	}))
	git.log.mockImplementation(async () => [{ oid: gitState.headCommit }])
	git.branch.mockImplementation(async () => ({
		branches: [gitState.currentBranch],
		current: gitState.currentBranch,
	}))
	git.checkout.mockImplementation(async () => ({
		ref: gitState.currentBranch,
	}))
	git.fetch.mockImplementation(async () => ({
		fetchHead: gitState.headCommit,
		fetchHeadDescription: 'main',
	}))
	git.pull.mockResolvedValue({ pulled: true })
	git.push.mockResolvedValue({ ok: true, refs: {} })
	git.diff.mockResolvedValue([])
}

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
		// Mirror the real backend closely enough for the applyEdits size gate:
		// planned edits carry the resulting content per instruction.
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

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<PublishedRuntimeArtifacts>(
		'#worker/package-runtime/published-runtime-artifacts.ts',
	)
	return {
		...actual,
		writePublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.writePublishedSourceSnapshot(...args),
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
const { deleteRepoSession, insertRepoSession } =
	await import('./repo-sessions.ts')
const { maxRepoSourceFileBytes } = await import('./large-file-policy.ts')

function createDurableObjectState() {
	const storageState = new Map<string, unknown>()
	return {
		id: { toString: () => 'do-session-1' },
		storage: {
			sql: { databaseSize: 16_384 },
			get: vi.fn(async (key: string) => storageState.get(key)),
			put: vi.fn(async (key: string, value: unknown) => {
				storageState.set(key, value)
			}),
			deleteAll: vi.fn(async () => {
				storageState.clear()
			}),
		},
		waitUntil: vi.fn(),
	} as unknown as DurableObjectState
}

function createEnv() {
	return {
		APP_DB: {},
	} as Env
}

function stubPackageSourceForOpenSession({
	repoId = 'package-event-runner',
	publishedCommit = 'commit-base',
	indexedCommit = publishedCommit,
	remoteNamespace = 'default',
	defaultBranch = 'main',
	headCommit = publishedCommit,
	createToken = true,
}: {
	repoId?: string
	publishedCommit?: string
	indexedCommit?: string
	remoteNamespace?: string
	defaultBranch?: string
	headCommit?: string | null
	createToken?: boolean
} = {}) {
	const remote = `https://acct.artifacts.cloudflare.net/git/${remoteNamespace}/${repoId}.git`
	mockModule.getRepoSessionById.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: repoId,
		published_commit: publishedCommit,
		indexed_commit: indexedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	})
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			id: 'source-repo-1',
			name: repoId,
			description: null,
			defaultBranch: 'main',
			createdAt: '2026-04-16T00:00:00.000Z',
			updatedAt: '2026-04-16T00:00:00.000Z',
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote,
		})),
		createToken: createToken
			? vi.fn(async () => ({
					id: 'token-1',
					plaintext: 'art_source_secret?expires=1760000200',
					scope: 'write',
					expiresAt: '2026-10-09T08:16:40.000Z',
				}))
			: vi.fn(),
	})
	if (headCommit === null) {
		mockModule.resolveArtifactDefaultBranchHead.mockResolvedValueOnce(null)
	} else {
		mockModule.resolveArtifactDefaultBranchHead.mockResolvedValueOnce({
			defaultBranch,
			commit: headCommit,
			remote,
		})
	}
	return { remote }
}

function setCommonSessionFixtures() {
	restoreRepoSessionMockBaseline()
	mockModule.getRepoSessionById.mockResolvedValue({
		id: 'session-1',
		user_id: 'user-1',
		source_id: 'source-1',
		source_repo_id: 'source-repo',
		session_branch: 'sessions/session1',
		source_branch: 'main',
		base_commit: 'commit-base',
		status: 'active',
		last_checkpoint_commit: 'commit-base',
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'source-repo',
		published_commit: 'commit-base',
		manifest_path: 'kody.json',
		source_root: '/',
	})
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			id: 'source-repo-id',
			name: 'source-repo',
			defaultBranch: 'main',
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_source_secret?expires=1760000100',
		})),
	})
	mockModule.gitState.currentBranch = 'main'
	mockModule.gitState.headCommit = 'commit-head'
	mockModule.gitState.statusEntries = []
	mockModule.gitState.remotes = [
		{
			remote: 'origin',
			url: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		},
	]
	mockModule.git.pull.mockClear()
	mockModule.git.push.mockClear()
	mockModule.updateRepoSession.mockClear()
	mockModule.updateEntitySource.mockClear()
}

test('repo sessions inventory workspace bytes through open, mutation, and cleanup', async () => {
	setCommonSessionFixtures()
	const state = createDurableObjectState()
	const env = createEnv()
	const repoSession = new RepoSession(state, env)

	await expect(repoSession.getEstimatedBytes()).resolves.toEqual({
		estimatedBytes: 16_384,
	})
	await repoSession.openSession({
		sessionId: 'session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://example.com',
	})
	expect(mockModule.registerStorageBucketAndWait).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		storageId: 'repo-session:session-1',
		kind: 'repo_session',
	})
	expect(mockModule.maybeRefreshStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			userId: 'user-1',
			storageId: 'repo-session:session-1',
			readEstimatedBytes: expect.any(Function),
			waitUntil: expect.any(Function),
		}),
	)

	mockModule.maybeRefreshStorageBucketEstimate.mockClear()
	await repoSession.writeFile({
		sessionId: 'session-1',
		userId: 'user-1',
		path: 'src/index.ts',
		content: 'export const ready = true\n',
	})
	expect(mockModule.maybeRefreshStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			storageId: 'repo-session:session-1',
		}),
	)

	await repoSession.discardSession({
		sessionId: 'session-1',
		userId: 'user-1',
	})
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'user-1',
		storageId: 'repo-session:session-1',
	})

	mockModule.deleteStorageBucketInventory.mockClear()
	await repoSession.purgeSession({
		sessionId: 'session-1',
		userId: 'user-1',
	})
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'user-1',
		storageId: 'repo-session:session-1',
	})
})

test('rebaseSession and publishSession use Artifacts username/password auth without token override', async () => {
	// Best-effort publish git-note attachment fails in this mocked git
	// environment and logs a warning that is incidental to auth behavior;
	// it is asserted at the end of the test.
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.writePublishedSourceSnapshot.mockClear()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await repoSession.rebaseSession({
		sessionId: 'session-1',
		userId: 'user-1',
	})
	expect(mockModule.git.pull).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'main',
			username: 'x',
			password: 'art_source_secret',
		}),
	)
	expect(mockModule.git.pull).toHaveBeenCalledWith(
		expect.not.objectContaining({ token: expect.anything() }),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'sessions/session1',
			username: 'x',
			password: 'art_source_secret',
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.not.objectContaining({ token: expect.anything() }),
	)

	mockModule.git.pull.mockClear()
	mockModule.git.push.mockClear()
	mockModule.rawPush.mockClear()
	await repoSession.publishSession({
		sessionId: 'session-1',
		userId: 'user-1',
		force: true,
	})
	expect(mockModule.git.push).toHaveBeenCalledTimes(1)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'sessions/session1',
			username: 'x',
			password: 'art_source_secret',
		}),
	)
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.objectContaining({
			fs: expect.objectContaining({
				promises: expect.objectContaining({
					rmdir: expect.any(Function),
					unlink: expect.any(Function),
				}),
			}),
			remote: 'origin',
			ref: 'sessions/session1',
			remoteRef: 'main',
		}),
	)
	for (const call of mockModule.git.push.mock.calls) {
		expect(call[0]).not.toHaveProperty('token')
	}

	mockModule.rawPush.mockClear()
	const cleanupResult = await repoSession.cleanupSessionBranch({
		sessionId: 'session-1',
		userId: 'user-1',
		reason: 'expired',
	})
	expect(cleanupResult).toEqual({
		ok: true,
		sessionId: 'session-1',
		branch: 'sessions/session1',
		branchDeleted: true,
	})
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'sessions/session1',
			delete: true,
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('publish_git_note'),
		expect.anything(),
	)
})

test('cleanupSessionBranch removes the D1 session row when remote branch delete fails', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.rawPush.mockRejectedValueOnce(
		new TypeError("Cannot read properties of undefined (reading 'bind')"),
	)
	vi.mocked(deleteRepoSession).mockClear()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const result = await repoSession.cleanupSessionBranch({
		sessionId: 'session-1',
		userId: 'user-1',
		reason: 'expired',
	})

	expect(result).toEqual({
		ok: true,
		sessionId: 'session-1',
		branch: 'sessions/session1',
		branchDeleted: false,
	})
	expect(deleteRepoSession).toHaveBeenCalledWith(expect.anything(), 'session-1')
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		storageId: 'repo-session:session-1',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('repo session remote branch delete failed'),
	)
})

test('applyPatch applies unified diff patches (modify, delete, and rename)', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/src/keep.ts') return 'export const keep = false\n'
		if (path === '/session/src/delete.ts') return 'export const remove = true\n'
		if (path === '/session/src/old-name.ts')
			return 'export const name = "old"\n'
		return ''
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const modifyAndDelete = await repoSession.applyPatch({
		sessionId: 'session-1',
		userId: 'user-1',
		patch: [
			'--- a/src/keep.ts',
			'+++ b/src/keep.ts',
			'@@ -1 +1 @@',
			'-export const keep = false',
			'+export const keep = true',
			'--- a/src/delete.ts',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-export const remove = true',
		].join('\n'),
	})

	expect(mockModule.workspaceWriteFile).toHaveBeenCalledWith(
		'/session/src/keep.ts',
		'export const keep = true\n',
	)
	expect(mockModule.workspaceRm).toHaveBeenCalledWith(
		'/session/src/delete.ts',
		{
			force: true,
		},
	)
	expect(modifyAndDelete.edits).toEqual([
		expect.objectContaining({
			path: 'src/keep.ts',
			content: 'export const keep = true\n',
		}),
		expect.objectContaining({
			path: 'src/delete.ts',
			content: '',
		}),
	])
	expect(modifyAndDelete.edits[0]?.diff).toContain('src/keep.ts')
	expect(modifyAndDelete.edits[0]?.diff).not.toContain('src/delete.ts')
	expect(modifyAndDelete.edits[1]?.diff).toContain('src/delete.ts')
	expect(modifyAndDelete.edits[1]?.diff).not.toContain('src/keep.ts')

	const rename = await repoSession.applyPatch({
		sessionId: 'session-1',
		userId: 'user-1',
		patch: [
			'--- a/src/old-name.ts',
			'+++ b/src/new-name.ts',
			'@@ -1 +1 @@',
			'-export const name = "old"',
			'+export const name = "new"',
		].join('\n'),
	})

	expect(mockModule.workspaceReadFile).toHaveBeenCalledWith(
		'/session/src/old-name.ts',
	)
	expect(mockModule.workspaceRm).toHaveBeenCalledWith(
		'/session/src/old-name.ts',
		{
			force: true,
		},
	)
	expect(mockModule.workspaceWriteFile).toHaveBeenCalledWith(
		'/session/src/new-name.ts',
		'export const name = "new"\n',
	)
	expect(rename.edits[0]).toEqual(
		expect.objectContaining({
			path: 'src/new-name.ts',
			content: 'export const name = "new"\n',
		}),
	)
})

test('applyPatch is all-or-nothing when a later patch exceeds the size limit', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/src/keep.ts') return 'export const keep = false\n'
		return ''
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const oversizedLine = 'x'.repeat(maxRepoSourceFileBytes + 1)
	await expect(
		repoSession.applyPatch({
			sessionId: 'session-1',
			userId: 'user-1',
			patch: [
				'--- a/src/keep.ts',
				'+++ b/src/keep.ts',
				'@@ -1 +1 @@',
				'-export const keep = false',
				'+export const keep = true',
				'--- /dev/null',
				'+++ b/assets/huge.txt',
				'@@ -0,0 +1 @@',
				`+${oversizedLine}`,
			].join('\n'),
		}),
	).rejects.toThrow(/"assets\/huge\.txt".*per-file limit/s)
	expect(mockModule.workspaceWriteFile).not.toHaveBeenCalled()
	expect(mockModule.workspaceRm).not.toHaveBeenCalled()
})

test('applyEdits delete edit removes a file', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceExists.mockImplementation(async (path: string) =>
		path === '/session/src/remove.ts' ? true : false,
	)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/src/remove.ts') return 'export const gone = true\n'
		return ''
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const result = await repoSession.applyEdits({
		sessionId: 'session-1',
		userId: 'user-1',
		edits: [{ kind: 'delete', path: 'src/remove.ts' }],
	})

	expect(mockModule.workspaceRm).toHaveBeenCalledWith(
		'/session/src/remove.ts',
		{
			force: true,
		},
	)
	expect(result.totalChanged).toBe(1)
	expect(result.edits[0]).toMatchObject({
		path: 'src/remove.ts',
		changed: true,
		content: '',
	})
})

test('applyEdits move edit renames a file preserving content', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceExists.mockImplementation(async (path: string) =>
		path === '/session/src/old.ts' ? true : false,
	)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/src/old.ts') return 'export const value = 1\n'
		return ''
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const result = await repoSession.applyEdits({
		sessionId: 'session-1',
		userId: 'user-1',
		edits: [{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' }],
	})

	expect(mockModule.workspaceWriteFile).toHaveBeenCalledWith(
		'/session/src/new.ts',
		'export const value = 1\n',
	)
	expect(mockModule.workspaceRm).toHaveBeenCalledWith('/session/src/old.ts', {
		force: true,
	})
	expect(result.edits[0]).toMatchObject({
		path: 'src/new.ts',
		content: 'export const value = 1\n',
	})
})

test('applyEdits rejects batches mixing structural and content edits on the same path', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceExists.mockResolvedValue(true)
	mockModule.workspaceReadFile.mockResolvedValue('export const value = 1\n')
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	// delete + write on the same path is ambiguous (structural edits run last).
	await expect(
		repoSession.applyEdits({
			sessionId: 'session-1',
			userId: 'user-1',
			edits: [
				{ kind: 'delete', path: 'src/a.ts' },
				{ kind: 'write', path: 'src/a.ts', content: 'export const a = 2\n' },
			],
		}),
	).rejects.toThrow(/cannot combine a delete\/move/)

	// move whose source is rewritten in the same batch would capture stale
	// content; ./-prefixed paths must still collide after resolution.
	await expect(
		repoSession.applyEdits({
			sessionId: 'session-1',
			userId: 'user-1',
			edits: [
				{ kind: 'write', path: './src/a.ts', content: 'export const a = 2\n' },
				{ kind: 'move', path: 'src/a.ts', to: 'src/b.ts' },
			],
		}),
	).rejects.toThrow(/cannot combine a delete\/move/)
	expect(mockModule.workspaceRm).not.toHaveBeenCalled()
})

test('applyEdits move succeeds for a grandfathered oversized file because content is unchanged', async () => {
	setCommonSessionFixtures()
	const oversizedContent = 'x'.repeat(maxRepoSourceFileBytes + 1)
	mockModule.workspaceExists.mockImplementation(async (path: string) =>
		path === '/session/assets/huge.bin' ? true : false,
	)
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/assets/huge.bin') return oversizedContent
		return ''
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await expect(
		repoSession.applyEdits({
			sessionId: 'session-1',
			userId: 'user-1',
			edits: [
				{
					kind: 'move',
					path: 'assets/huge.bin',
					to: 'assets/huge-renamed.bin',
				},
			],
		}),
	).resolves.toMatchObject({ totalChanged: 1 })
})

test('restoreFiles restores modified files to the session base commit', async () => {
	setCommonSessionFixtures()
	mockModule.readBlob.mockResolvedValueOnce({
		blob: new TextEncoder().encode('base content\n'),
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const result = await repoSession.restoreFiles({
		sessionId: 'session-1',
		userId: 'user-1',
		paths: ['src/index.ts'],
	})

	expect(mockModule.readBlob).toHaveBeenCalledWith(
		expect.objectContaining({
			filepath: 'src/index.ts',
			oid: 'commit-base',
		}),
	)
	expect(mockModule.workspaceWriteFileBytes).toHaveBeenCalledWith(
		'/session/src/index.ts',
		new TextEncoder().encode('base content\n'),
	)
	expect(result).toEqual({
		commit: 'commit-base',
		restored: ['src/index.ts'],
	})
})

test('sessionCommit rejects empty commit messages', async () => {
	setCommonSessionFixtures()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await expect(
		repoSession.sessionCommit({
			sessionId: 'session-1',
			userId: 'user-1',
			message: '   ',
		}),
	).rejects.toThrow('Commit message cannot be empty.')
	expect(mockModule.git.add).not.toHaveBeenCalled()
	expect(mockModule.git.commit).not.toHaveBeenCalled()
})

test('applyEdits rejects a write over the per-file repo size limit with hosting guidance', async () => {
	setCommonSessionFixtures()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await expect(
		repoSession.applyEdits({
			sessionId: 'session-1',
			userId: 'user-1',
			edits: [
				{
					kind: 'write',
					path: 'assets/dataset.csv',
					content: 'x'.repeat(maxRepoSourceFileBytes + 1),
				},
			],
		}),
	).rejects.toThrow(/"assets\/dataset\.csv".*per-file limit.*Cloudflare R2/s)
	expect(mockModule.workspaceWriteFile).not.toHaveBeenCalled()
})

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

test('openSession sanitizes repo names, persists namespace metadata, and rejects stale package source heads', async () => {
	restoreRepoSessionMockBaseline()
	const { remote: defaultRemote } = stubPackageSourceForOpenSession()
	mockModule.git.clone.mockClear()

	const repoSession = new RepoSession(createDurableObjectState(), createEnv())
	const opened = await repoSession.openSession({
		sessionId:
			'job-runtime-package-job:1a0476b4-c1d6-47ad-802e-dd5f4631c919:event-runner-123e4567-e89b-12d3-a456-426614174000',
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://example.com',
		sourceRoot: '/',
	})
	expect(opened.session_branch).toMatch(/^sessions\/[a-z0-9]+-[a-f0-9]{32}$/)
	expect(opened.session_branch).not.toContain(':')
	expect(mockModule.git.clone).toHaveBeenCalledWith(
		expect.objectContaining({
			url: defaultRemote,
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: opened.session_branch,
		}),
	)
	expect(
		mockModule.markEntitySourcePendingExternalReconcile,
	).toHaveBeenCalledWith(expect.anything(), {
		id: 'source-1',
		userId: 'user-1',
		tokenExpiresAt: expect.any(String),
	})

	restoreRepoSessionMockBaseline()
	stubPackageSourceForOpenSession({
		publishedCommit: 'commit-release',
		defaultBranch: 'release',
	})
	mockModule.resolveArtifactDefaultBranchHead.mockResolvedValueOnce({
		defaultBranch: 'release',
		commit: 'commit-release',
		remote:
			'https://acct.artifacts.cloudflare.net/git/default/package-event-runner.git',
	})
	vi.mocked(insertRepoSession).mockClear()
	await new RepoSession(createDurableObjectState(), createEnv()).openSession({
		sessionId: 'session-release-branch',
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://example.com',
		sourceRoot: '/',
	})
	expect(insertRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			source_branch: 'release',
		}),
	)
	await expect(
		new RepoSession(createDurableObjectState(), createEnv()).openSession({
			sessionId: 'session-conflicting-branch',
			sourceId: 'source-1',
			userId: 'user-1',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
			defaultBranch: 'main',
		}),
	).rejects.toThrow(/published from "release"/)

	restoreRepoSessionMockBaseline()
	stubPackageSourceForOpenSession({ remoteNamespace: 'preview' })
	vi.mocked(insertRepoSession).mockClear()
	await new RepoSession(createDurableObjectState(), {
		APP_DB: {},
		ARTIFACTS_NAMESPACE: 'preview',
	} as Env).openSession({
		sessionId: 'session-preview-namespace',
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://example.com',
		sourceRoot: '/',
	})
	expect(insertRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			session_branch: expect.stringMatching(/^sessions\//),
			source_branch: 'main',
		}),
	)

	restoreRepoSessionMockBaseline()
	mockModule.getRepoSessionById.mockResolvedValue({
		id: 'discarded-session',
		user_id: 'user-1',
		source_id: 'source-1',
		source_repo_id: 'source-repo',
		session_branch: 'sessions/discarded',
		source_branch: 'main',
		status: 'discarded',
	})
	await expect(
		new RepoSession(createDurableObjectState(), createEnv()).openSession({
			sessionId: 'discarded-session',
			sourceId: 'source-1',
			userId: 'user-1',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		}),
	).rejects.toThrow(/is discarded/)

	restoreRepoSessionMockBaseline()
	stubPackageSourceForOpenSession({
		repoId: 'package-package-1',
		headCommit: null,
		createToken: false,
	})
	mockModule.resolveArtifactSourceRepo.mockClear()
	await expect(
		new RepoSession(createDurableObjectState(), createEnv()).openSession({
			sessionId: 'session-empty-source-head',
			sourceId: 'source-1',
			userId: 'user-1',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		}),
	).rejects.toThrow(/default branch has no HEAD/)
	expect(mockModule.resolveArtifactSourceRepo).not.toHaveBeenCalled()

	restoreRepoSessionMockBaseline()
	stubPackageSourceForOpenSession({
		repoId: 'package-package-1',
		publishedCommit: 'commit-published',
		headCommit: 'commit-unpublished',
		createToken: false,
	})
	await expect(
		new RepoSession(createDurableObjectState(), createEnv()).openSession({
			sessionId: 'session-stale-source-head',
			sourceId: 'source-1',
			userId: 'user-1',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		}),
	).rejects.toThrow(/does not match published commit/)
})

test('readFile retries D1 reads and falls back to cached sessions when replicas lag', async () => {
	restoreRepoSessionMockBaseline()
	const replicaLagSessionRow = {
		id: 'job-runtime-session-replica-lag',
		user_id: 'user-1',
		source_id: 'source-1',
		source_repo_id: 'source-repo',
		session_branch: 'sessions/jobruntimesessionreplicalag',
		source_branch: 'main',
		base_commit: 'commit-base',
		source_root: '/',
		conversation_id: null,
		status: 'active' as const,
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
	const replicaLagSource = {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'job' as const,
		entity_id: 'job-1',
		repo_id: 'job-job-1',
		published_commit: 'commit-base',
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
	mockModule.getRepoSessionById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(replicaLagSessionRow)
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(replicaLagSource)
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote: 'https://acct.artifacts.cloudflare.net/git/default/job-job-1.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_source_secret?expires=1760000200',
		})),
	})
	mockModule.workspaceReadFile.mockResolvedValue('{"version":1,"kind":"job"}')

	const replicaLagSession = new RepoSession(
		createDurableObjectState(),
		createEnv(),
	)
	const replicaLagFile = await replicaLagSession.readFile({
		sessionId: 'job-runtime-session-replica-lag',
		userId: 'user-1',
		path: 'kody.json',
	})
	expect(replicaLagFile).toEqual({
		path: 'kody.json',
		content: '{"version":1,"kind":"job"}',
	})
	expect(mockModule.getRepoSessionById).toHaveBeenCalledTimes(3)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)

	setCommonSessionFixtures()
	const initialSource = {
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'source-repo',
		published_commit: 'commit-initial',
		manifest_path: 'kody.json',
		source_root: '/',
	}
	const initialSession = {
		id: 'session-1',
		user_id: 'user-1',
		source_id: 'source-1',
		source_repo_id: 'source-repo',
		session_branch: 'sessions/session1',
		source_branch: 'main',
		base_commit: 'commit-initial',
		status: 'active',
		last_checkpoint_commit: 'commit-initial',
	}
	const movedSession = {
		...initialSession,
		base_commit: 'commit-rebased',
		last_checkpoint_commit: 'commit-rebased',
	}
	const movedSource = {
		...initialSource,
		published_commit: 'commit-moved',
	}
	mockModule.getRepoSessionById
		.mockResolvedValueOnce(initialSession)
		.mockResolvedValueOnce(movedSession)
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(initialSource)
		.mockResolvedValueOnce(movedSource)
	mockModule.workspaceReadFile.mockResolvedValue('hello world')

	const updatedRowSession = new RepoSession(
		createDurableObjectState(),
		createEnv(),
	)
	const firstRead = await updatedRowSession.readFile({
		sessionId: 'session-1',
		userId: 'user-1',
		path: 'greeting.txt',
	})
	expect(firstRead).toEqual({
		path: 'greeting.txt',
		content: 'hello world',
	})

	const secondRead = await updatedRowSession.readFile({
		sessionId: 'session-1',
		userId: 'user-1',
		path: 'greeting.txt',
	})
	expect(secondRead).toEqual({
		path: 'greeting.txt',
		content: 'hello world',
	})
	expect(mockModule.getRepoSessionById).toHaveBeenCalledTimes(5)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(4)

	mockModule.getRepoSessionById.mockReset()
	mockModule.getEntitySourceById.mockReset()
	const cachedFallbackSource = {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'job' as const,
		entity_id: 'job-1',
		repo_id: 'job-job-1',
		published_commit: 'commit-base',
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
	mockModule.getRepoSessionById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(cachedFallbackSource)
		.mockResolvedValueOnce(cachedFallbackSource)
		.mockResolvedValueOnce(null)
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			id: 'job-repo-1',
			name: 'job-job-1',
			description: null,
			defaultBranch: 'main',
			createdAt: '2026-04-16T00:00:00.000Z',
			updatedAt: '2026-04-16T00:00:00.000Z',
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote: 'https://acct.artifacts.cloudflare.net/git/default/job-job-1.git',
		})),
		createToken: vi.fn(async () => ({
			id: 'token-1',
			plaintext: 'art_source_secret?expires=1760000200',
			scope: 'write',
			expiresAt: '2026-10-09T08:16:40.000Z',
		})),
	})
	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.workspaceReadFile.mockResolvedValue('export default {}')

	const cachedFallbackSession = new RepoSession(
		createDurableObjectState(),
		createEnv(),
	)
	await cachedFallbackSession.openSession({
		sessionId: 'job-runtime-session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://example.com',
		sourceRoot: '/',
	})
	const cachedFallbackFile = await cachedFallbackSession.readFile({
		sessionId: 'job-runtime-session-1',
		userId: 'user-1',
		path: 'kody.json',
	})

	expect(cachedFallbackFile).toEqual({
		path: 'kody.json',
		content: 'export default {}',
	})
})

test('publishFromExternalRef rejects stale expected HEAD values', async () => {
	setCommonSessionFixtures()
	// Clone tip (git.log depth 1) is the remote default-branch HEAD at clone
	// time; a mismatch with expectedHead means the Artifacts tip moved.
	mockModule.gitState.headCommit = 'commit-new'

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

test('publishFromExternalRef checks fast-forward ancestry through shell git adapter', async () => {
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
	mockModule.git.log.mockResolvedValueOnce([
		{ oid: 'commit-new' },
		{ oid: 'commit-old' },
	])
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
	expect(mockModule.git.log).toHaveBeenCalledWith({
		dir: '/session',
		ref: 'commit-new',
		depth: Number.POSITIVE_INFINITY,
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
