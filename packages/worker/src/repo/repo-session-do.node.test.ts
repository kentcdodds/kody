import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	instrumentDurableObjectWithSentry: vi.fn(
		(_getOptions: unknown, durableObjectClass: unknown) => durableObjectClass,
	),
	Workspace: vi.fn(),
	WorkspaceFileSystem: vi.fn(),
	createWorkspaceStateBackend: vi.fn(),
	createGit: vi.fn(),
	resolveSessionRepo: vi.fn(),
	runRepoChecks: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	instrumentDurableObjectWithSentry: (...args: Array<unknown>) =>
		mockModule.instrumentDurableObjectWithSentry(...args),
}))

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected readonly ctx: DurableObjectState
		protected readonly env: Env

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx
			this.env = env
		}
	},
}))

vi.mock('@cloudflare/shell', () => ({
	Workspace: class {
		private hasWorkspace = false

		constructor(...args: Array<unknown>) {
			mockModule.Workspace(...args)
		}

		async exists() {
			return this.hasWorkspace
		}

		async mkdir() {
			this.hasWorkspace = true
		}

		async rm() {
			this.hasWorkspace = false
		}

		async glob() {
			return []
		}

		async readFile() {
			return null
		}
	},
	WorkspaceFileSystem: class {
		constructor(...args: Array<unknown>) {
			mockModule.WorkspaceFileSystem(...args)
		}
	},
	createWorkspaceStateBackend: (...args: Array<unknown>) => {
		mockModule.createWorkspaceStateBackend(...args)
		return {}
	},
}))

vi.mock('@cloudflare/shell/git', () => ({
	createGit: (...args: Array<unknown>) => {
		mockModule.createGit(...args)
		return {
			remote: vi.fn(async () => []),
			clone: vi.fn(async () => undefined),
		}
	},
}))

vi.mock('./artifacts.ts', async () => {
	const actual = await vi.importActual<typeof import('./artifacts.ts')>(
		'./artifacts.ts',
	)
	return {
		...actual,
		resolveSessionRepo: (...args: Array<unknown>) =>
			mockModule.resolveSessionRepo(...args),
	}
})

vi.mock('./checks.ts', async () => {
	const actual = await vi.importActual<typeof import('./checks.ts')>(
		'./checks.ts',
	)
	return {
		...actual,
		runRepoChecks: (...args: Array<unknown>) => mockModule.runRepoChecks(...args),
	}
})

const { RepoSession } = await import('./repo-session-do.ts')

function createSessionDatabase() {
	const sources = new Map<string, Record<string, unknown>>([
		[
			'source-1',
			{
				id: 'source-1',
				user_id: 'user-1',
				entity_kind: 'job',
				entity_id: 'job-1',
				repo_id: 'repo-1',
				published_commit: 'commit-1',
				indexed_commit: 'commit-1',
				manifest_path: 'kody.json',
				source_root: '/src',
				created_at: '2026-04-18T00:00:00.000Z',
				updated_at: '2026-04-18T00:00:00.000Z',
			},
		],
	])
	const sessions = new Map<string, Record<string, unknown>>([
		[
			'session-1',
			{
				id: 'session-1',
				user_id: 'user-1',
				source_id: 'source-1',
				session_repo_id: 'session-repo-1',
				session_repo_name: 'session-repo-name',
				session_repo_namespace: 'default',
				base_commit: 'commit-1',
				source_root: '/',
				conversation_id: null,
				status: 'active',
				expires_at: null,
				last_checkpoint_at: null,
				last_checkpoint_commit: 'commit-1',
				last_check_run_id: null,
				last_check_tree_hash: null,
				created_at: '2026-04-18T00:00:00.000Z',
				updated_at: '2026-04-18T00:00:00.000Z',
			},
		],
	])

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (query.includes('FROM repo_sessions WHERE id = ?')) {
								return (sessions.get(String(params[0])) ?? null) as T | null
							}
							if (query.includes('FROM entity_sources WHERE id = ?')) {
								return (sources.get(String(params[0])) ?? null) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							if (
								query.includes('UPDATE repo_sessions SET') &&
								query.includes('WHERE id = ? AND user_id = ?')
							) {
								const sessionId = String(params.at(-2))
								const userId = String(params.at(-1))
								const existing = sessions.get(sessionId)
								if (!existing || existing['user_id'] !== userId) {
									return { meta: { changes: 0 } }
								}
								const assignments = query
									.slice(
										query.indexOf('SET') + 3,
										query.indexOf('WHERE'),
									)
									.split(',')
									.map((part) => part.trim())
								const next = { ...existing }
								assignments.forEach((assignment, index) => {
									const column = assignment.split('=')[0]?.trim()
									if (column) next[column] = params[index]
								})
								sessions.set(sessionId, next)
								return { meta: { changes: 1 } }
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createState() {
	const storageValues = new Map<string, unknown>()
	return {
		storage: {
			get: vi.fn(async (key: string) => storageValues.get(key)),
			put: vi.fn(async (key: string, value: unknown) => {
				storageValues.set(key, value)
			}),
		},
		blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) =>
			Promise.resolve().then(callback),
		),
	} as unknown as DurableObjectState
}

test('runChecks uses the active session source root instead of a stale persisted source root', async () => {
	mockModule.Workspace.mockReset()
	mockModule.WorkspaceFileSystem.mockReset()
	mockModule.createWorkspaceStateBackend.mockReset()
	mockModule.createGit.mockReset()
	mockModule.resolveSessionRepo.mockReset()
	mockModule.runRepoChecks.mockReset()

	mockModule.resolveSessionRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote: 'https://example.com/session.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'token-123?expires=1760000000',
		})),
	})
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [],
		manifest: {
			version: 1,
			kind: 'job',
			title: 'Repo-backed job',
			description: 'Runs from repo',
			entrypoint: '/src/job.ts',
		},
	})

	const repoSession = new RepoSession(
		createState(),
		{
			APP_DB: createSessionDatabase(),
		} as Env,
	)

	await repoSession.runChecks({
		sessionId: 'session-1',
		userId: 'user-1',
	})

	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			manifestPath: '/session/kody.json',
			sourceRoot: '/session/',
		}),
	)
})
