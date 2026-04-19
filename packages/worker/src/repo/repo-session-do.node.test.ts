import { expect, test, vi } from 'vitest'

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
	}
})

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('cloudflare:workers')>()
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
	const actual =
		await vi.importActual<typeof import('./artifacts.ts')>('./artifacts.ts')
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

const { RepoSession } = await import('./repo-session-do.ts')

function createDurableObjectState() {
	return {
		id: { toString: () => 'do-session-1' },
		storage: {
			sql: {},
			get: mockModule.storageGet,
			put: mockModule.storagePut,
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

test('publishSession uses Artifacts username/password auth for both origin and source pushes', async () => {
	setCommonSessionFixtures()
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
