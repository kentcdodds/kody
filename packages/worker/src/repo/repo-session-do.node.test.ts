import { expect, test, vi } from 'vitest'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'

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
		commit: vi.fn(async () => ({
			oid: gitState.headCommit,
			message: 'commit',
		})),
		log: vi.fn(async () => [{ oid: gitState.headCommit }]),
		branch: vi.fn(async () => ({
			branches: [gitState.currentBranch],
			current: gitState.currentBranch,
		})),
		pull: vi.fn(async () => ({ pulled: true })),
		push: vi.fn(async () => ({ ok: true, refs: {} })),
	}

	return {
		git,
		gitState,
		workspaceExists: vi.fn(
			async (path: string) => path === '/session/.git/config',
		),
		workspaceReadFile: vi.fn(async () => '{"version":1,"kind":"app"}'),
		workspaceWriteFile: vi.fn(async () => undefined),
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
		resolveSessionRepo: vi.fn(),
		resolveArtifactSourceRepo: vi.fn(),
		parseRepoManifest: vi.fn(() => ({ sourceRoot: '/' })),
		writePublishedSourceSnapshot: vi.fn(async () => 'snapshot-key'),
	}
})

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
		planEdits: vi.fn(),
		applyEditPlan: vi.fn(),
		walkTree: vi.fn(),
	})),
}))

vi.mock('@cloudflare/shell/git', () => ({
	createGit: vi.fn(() => mockModule.git),
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
}))

vi.mock('./artifacts.ts', async () => {
	const actual = await vi.importActual<Artifacts>('./artifacts.ts')
	return {
		...actual,
		resolveSessionRepo: (...args: Array<unknown>) =>
			mockModule.resolveSessionRepo(...args),
		resolveArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceRepo(...args),
	}
})

vi.mock('./manifest.ts', () => ({
	parseRepoManifest: (...args: Array<unknown>) =>
		mockModule.parseRepoManifest(...args),
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

const { RepoSession, readWithRetry } = await import('./repo-session-do.ts')

function createDurableObjectState() {
	const storageState = new Map<string, unknown>()
	return {
		id: { toString: () => 'do-session-1' },
		storage: {
			sql: {},
			get: vi.fn(async (key: string) => storageState.get(key)),
			put: vi.fn(async (key: string, value: unknown) => {
				storageState.set(key, value)
			}),
		},
	} as unknown as DurableObjectState
}

function createEnv() {
	return {
		APP_DB: {},
	} as Env
}

function setCommonSessionFixtures() {
	mockModule.getRepoSessionById.mockResolvedValue({
		id: 'session-1',
		user_id: 'user-1',
		source_id: 'source-1',
		session_repo_namespace: 'default',
		session_repo_name: 'session-repo',
		base_commit: 'commit-base',
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
	mockModule.resolveSessionRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/session-repo.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_session_secret?expires=1760000200',
		})),
	})
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
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
			url: 'https://acct.artifacts.cloudflare.net/git/default/session-repo.git',
		},
	]
	mockModule.git.pull.mockClear()
	mockModule.git.push.mockClear()
	mockModule.updateRepoSession.mockClear()
	mockModule.updateEntitySource.mockClear()
}

test('rebaseSession uses Artifacts username/password auth without token override', async () => {
	setCommonSessionFixtures()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await repoSession.rebaseSession({
		sessionId: 'session-1',
		userId: 'user-1',
	})

	expect(mockModule.git.pull).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'source',
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
			ref: 'main',
			username: 'x',
			password: 'art_session_secret',
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.not.objectContaining({ token: expect.anything() }),
	)
})

test('syncSessionFromRemote pulls shell-pushed session commits into the workspace', async () => {
	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-before'
	mockModule.git.pull.mockImplementationOnce(async () => {
		mockModule.gitState.headCommit = 'commit-after'
		return { pulled: true }
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const result = await repoSession.syncSessionFromRemote({
		sessionId: 'session-1',
		userId: 'user-1',
	})

	expect(result).toEqual({
		ok: true,
		sessionId: 'session-1',
		headCommit: 'commit-after',
		changed: true,
	})
	expect(mockModule.git.pull).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'main',
			username: 'x',
			password: 'art_session_secret',
		}),
	)
	expect(mockModule.updateRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'session-1',
			userId: 'user-1',
			lastCheckpointCommit: 'commit-after',
		}),
	)
})

test('publishSession uses Artifacts username/password auth for both origin and source pushes', async () => {
	setCommonSessionFixtures()
	mockModule.writePublishedSourceSnapshot.mockClear()
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	await repoSession.publishSession({
		sessionId: 'session-1',
		userId: 'user-1',
		force: true,
	})

	expect(mockModule.git.push).toHaveBeenCalledTimes(2)
	expect(mockModule.git.push).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			remote: 'origin',
			ref: 'main',
			username: 'x',
			password: 'art_session_secret',
		}),
	)
	expect(mockModule.git.push).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			remote: 'source',
			ref: 'main',
			username: 'x',
			password: 'art_source_secret',
		}),
	)
	for (const call of mockModule.git.push.mock.calls) {
		expect(call[0]).not.toHaveProperty('token')
	}
})

test('publishSession persists the workspace snapshot to BUNDLE_ARTIFACTS_KV so downstream readers find the freshly published commit', async () => {
	// Regression test: repo_publish_session was throwing
	// "Published snapshot for source ... was not found" because the publish
	// handler updated D1 with the new commit without writing the KV snapshot
	// that loadPublishedEntitySource and package-backed jobs rely on. The
	// handler must persist the current workspace tree under the new commit
	// before any downstream read is attempted.
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
			return '{"version":1,"kind":"app"}'
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
		'kody.json': '{"version":1,"kind":"app"}',
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
})

test('publishSession rolls back the D1 published commit when snapshot persistence fails', async () => {
	// Matches the source-sync.ts revert behavior so a failed KV write never
	// leaves an entity source pointing at a commit whose snapshot nobody can
	// read. Without this, a partial failure would permanently break package
	// jobs for the source until it is republished.
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
	mockModule.workspaceReadFile.mockResolvedValue('{"version":1,"kind":"app"}')

	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as unknown as KVNamespace,
	} as Env
	const repoSession = new RepoSession(createDurableObjectState(), env)

	await expect(
		repoSession.publishSession({
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
})

test('publishSession surfaces the original snapshot error even when the compensating revert also fails', async () => {
	// If the KV snapshot write fails AND the compensating updateEntitySource
	// revert subsequently fails, we must still rethrow the original KV error
	// so operators see the real root cause instead of a misleading D1 error
	// about the failed compensation.
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
	mockModule.workspaceReadFile.mockResolvedValue('{"version":1,"kind":"app"}')

	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as unknown as KVNamespace,
	} as Env
	const repoSession = new RepoSession(createDurableObjectState(), env)

	await expect(
		repoSession.publishSession({
			sessionId: 'session-1',
			userId: 'user-1',
			force: true,
		}),
	).rejects.toThrow('kv write failed')

	expect(mockModule.updateEntitySource).toHaveBeenCalledTimes(2)
})

test('publishSession aborts before advancing the D1 published commit when snapshot collection fails', async () => {
	// Snapshot collection must happen BEFORE the entity_sources.published_commit
	// advance. Otherwise a glob/read failure (or a file that disappears between
	// glob and read) would leave D1 pointing at a commit whose snapshot was
	// never written — the exact failure mode the main regression is about.
	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-published-collect-fail'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.writePublishedSourceSnapshot.mockReset()
	mockModule.updateEntitySource.mockClear()
	mockModule.workspaceGlob.mockResolvedValue([
		{ type: 'file', path: '/session/kody.json' },
		{ type: 'file', path: '/session/src/index.ts' },
	] as unknown as Array<{ type: 'file'; path: string }>)
	// Simulate a file that vanished between glob and read. The manifest read
	// from readManifestFromWorkspace still needs to resolve so publishSession
	// reaches the snapshot-collection step; it is the follow-up collector's
	// pass over the workspace that must treat the null content as a hard
	// failure instead of silently dropping the file and writing an incomplete
	// KV snapshot.
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/kody.json') {
			return '{"version":1,"kind":"app"}'
		}
		return null
	})

	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {} as unknown as KVNamespace,
	} as Env
	const repoSession = new RepoSession(createDurableObjectState(), env)

	await expect(
		repoSession.publishSession({
			sessionId: 'session-1',
			userId: 'user-1',
			force: true,
		}),
	).rejects.toThrow(/Failed to read repo session file/)

	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('openSession strips unsupported characters from derived session repo names', async () => {
	mockModule.getRepoSessionById.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'package-event-runner',
		published_commit: 'commit-base',
		manifest_path: 'package.json',
		source_root: '/',
	})
	const fork = vi.fn(async ({ name }: { name: string }) => ({
		id: 'session-repo-1',
		name,
		description: null,
		defaultBranch: 'main',
		remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
		token: 'art_session_secret?expires=1760000200',
		expiresAt: '2026-10-09T08:16:40.000Z',
		repo: {
			info: vi.fn(async () => ({
				id: 'session-repo-1',
				name,
				description: null,
				defaultBranch: 'main',
				createdAt: '2026-04-16T00:00:00.000Z',
				updatedAt: '2026-04-16T00:00:00.000Z',
				lastPushAt: null,
				source: null,
				readOnly: false,
				remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
			})),
			createToken: vi.fn(async () => ({
				id: 'token-1',
				plaintext: 'art_session_secret?expires=1760000200',
				scope: 'write',
				expiresAt: '2026-10-09T08:16:40.000Z',
			})),
			fork: vi.fn(),
		},
	}))
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		fork,
	})
	mockModule.workspaceExists.mockResolvedValue(false)
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

	const forkName = fork.mock.calls[0]?.[0]?.name
	expect(forkName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
	expect(forkName).not.toContain(':')
	expect(forkName.length).toBeLessThanOrEqual(63)
	expect(opened.session_repo_name).toBe(forkName)
	expect(mockModule.git.clone).toHaveBeenCalledWith(
		expect.objectContaining({
			url: `https://acct.artifacts.cloudflare.net/git/default/${forkName}.git`,
		}),
	)
})

test('readFile retries the D1 lookup when the persisted cache is missing and the row is not yet readable', async () => {
	// This test covers the alarm-driven scheduled-job failure mode where a fresh
	// DO instance handles a follow-up RPC call before the in-memory cache from
	// openSession is available, and D1 read replicas have not yet caught up to
	// the freshly inserted repo session row.
	const sessionRow = {
		id: 'job-runtime-session-replica-lag',
		user_id: 'user-1',
		source_id: 'source-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'session-repo-name',
		session_repo_namespace: 'default',
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
	const source = {
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
		.mockResolvedValueOnce(sessionRow)
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(source)
	mockModule.resolveSessionRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/session-repo-name.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_session_secret?expires=1760000200',
		})),
	})
	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.workspaceReadFile.mockResolvedValue('{"version":1,"kind":"job"}')

	const repoSession = new RepoSession(createDurableObjectState(), createEnv())
	const file = await repoSession.readFile({
		sessionId: 'job-runtime-session-replica-lag',
		userId: 'user-1',
		path: 'kody.json',
	})

	expect(file).toEqual({
		path: 'kody.json',
		content: '{"version":1,"kind":"job"}',
	})
	expect(mockModule.getRepoSessionById).toHaveBeenCalledTimes(3)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)
})

test('readWithRetry distinguishes null from other falsy values', async () => {
	// readWithRetry treats only null as "missing". Falsy-but-present values
	// like 0, '', or false must be returned as-is instead of triggering
	// extra retries and a final null.
	for (const value of [0, '', false]) {
		const read = vi.fn(
			async () => value as unknown as number | string | boolean,
		)
		const result = await readWithRetry(read, [])
		expect(result).toBe(value)
		expect(read).toHaveBeenCalledTimes(1)
	}

	const nullRead = vi.fn(async () => null)
	const nullResult = await readWithRetry(nullRead, [0, 0])
	expect(nullResult).toBeNull()
	expect(nullRead).toHaveBeenCalledTimes(3)

	let attempts = 0
	const eventualRead = vi.fn(async () => {
		attempts += 1
		return attempts < 3 ? null : ('ok' as const)
	})
	const eventualResult = await readWithRetry(eventualRead, [0, 0, 0])
	expect(eventualResult).toBe('ok')
	expect(eventualRead).toHaveBeenCalledTimes(3)
})

test('getSessionState prefers fresh D1 reads over cached session and source rows', async () => {
	// Guards against a regression where the cache, populated by openSession,
	// would shadow fresh D1 reads and hide updates such as rebaseSession
	// writing a new base_commit or an external publish updating
	// source.published_commit. That would cause publishSession's base_moved
	// check to compare stale values and silently pass when the source has
	// actually moved.
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
		session_repo_namespace: 'default',
		session_repo_name: 'session-repo',
		base_commit: 'commit-initial',
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

	const repoSession = new RepoSession(createDurableObjectState(), createEnv())
	const firstRead = await repoSession.readFile({
		sessionId: 'session-1',
		userId: 'user-1',
		path: 'greeting.txt',
	})
	expect(firstRead).toEqual({
		path: 'greeting.txt',
		content: 'hello world',
	})

	const secondRead = await repoSession.readFile({
		sessionId: 'session-1',
		userId: 'user-1',
		path: 'greeting.txt',
	})
	expect(secondRead).toEqual({
		path: 'greeting.txt',
		content: 'hello world',
	})
	// The second readFile hits D1 again rather than short-circuiting on the
	// in-memory cache, so the updated session and source rows are visible.
	expect(mockModule.getRepoSessionById).toHaveBeenCalledTimes(2)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)
})

test('readFile falls back to cached session state when the session row is not yet readable from D1', async () => {
	const source = {
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
		.mockResolvedValueOnce(source)
		.mockResolvedValueOnce(source)
		.mockResolvedValueOnce(null)
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		fork: vi.fn(async ({ name }: { name: string }) => ({
			id: 'session-repo-1',
			name,
			description: null,
			defaultBranch: 'main',
			remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
			token: 'art_session_secret?expires=1760000200',
			expiresAt: '2026-10-09T08:16:40.000Z',
			repo: {
				info: vi.fn(),
				createToken: vi.fn(),
				fork: vi.fn(),
			},
		})),
	})
	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.workspaceReadFile.mockResolvedValue('export default {}')

	const repoSession = new RepoSession(createDurableObjectState(), createEnv())
	await repoSession.openSession({
		sessionId: 'job-runtime-session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://example.com',
		sourceRoot: '/',
	})
	const file = await repoSession.readFile({
		sessionId: 'job-runtime-session-1',
		userId: 'user-1',
		path: 'kody.json',
	})

	expect(file).toEqual({
		path: 'kody.json',
		content: 'export default {}',
	})
})
