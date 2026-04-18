import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(),
	hasArtifactsAccess: vi.fn(() => true),
	parseArtifactTokenSecret: vi.fn((token: string) =>
		token.replace(/\?expires=.*$/, ''),
	),
	resolveArtifactSourceRepo: vi.fn(),
	parseRepoManifest: vi.fn(),
	repoSessionRpc: vi.fn(),
	createGit: vi.fn(),
	fsMkdir: vi.fn(),
	fsWriteFile: vi.fn(),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('./artifacts.ts', () => ({
	hasArtifactsAccess: (...args: Array<unknown>) =>
		mockModule.hasArtifactsAccess(...args),
	parseArtifactTokenSecret: (...args: Array<unknown>) =>
		mockModule.parseArtifactTokenSecret(...args),
	resolveArtifactSourceRepo: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceRepo(...args),
}))

vi.mock('./manifest.ts', () => ({
	parseRepoManifest: (...args: Array<unknown>) =>
		mockModule.parseRepoManifest(...args),
}))

vi.mock('./repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mockModule.repoSessionRpc(...args),
}))

vi.mock('@cloudflare/shell', () => ({
	InMemoryFs: class {
		mkdir = mockModule.fsMkdir
		writeFile = mockModule.fsWriteFile
	},
}))

vi.mock('@cloudflare/shell/git', () => ({
	createGit: (...args: Array<unknown>) => mockModule.createGit(...args),
}))

const { syncArtifactSourceSnapshot } = await import('./source-sync.ts')

function createDb() {
	return {
		prepare() {
			return {}
		},
	} as unknown as D1Database
}

function createSource(
	overrides: Partial<{
		published_commit: string | null
		source_root: string
	}> = {},
) {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'skill' as const,
		entity_id: 'skill-1',
		repo_id: 'repo-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		...overrides,
	}
}

test('syncArtifactSourceSnapshot bootstraps the first publish directly to the source repo', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.hasArtifactsAccess.mockReset()
	mockModule.parseArtifactTokenSecret.mockReset()
	mockModule.resolveArtifactSourceRepo.mockReset()
	mockModule.parseRepoManifest.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.createGit.mockReset()
	mockModule.fsMkdir.mockReset()
	mockModule.fsWriteFile.mockReset()

	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.parseArtifactTokenSecret.mockImplementation((token: string) =>
		token.replace(/\?expires=.*$/, ''),
	)
	mockModule.getEntitySourceById.mockResolvedValue(createSource())
	mockModule.parseRepoManifest.mockReturnValue({
		sourceRoot: 'src',
	})
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			defaultBranch: 'main',
			remote: 'https://artifacts.example/repos/repo-1.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_v1_write?expires=1760000000',
		})),
	})

	const gitClient = {
		init: vi.fn(async () => ({ initialized: '/' })),
		remote: vi.fn(async () => ({ added: 'origin', url: 'unused' })),
		add: vi.fn(async () => ({ added: '.' })),
		commit: vi.fn(async () => ({
			oid: 'commit-bootstrap',
			message: 'Bootstrap source source-1',
		})),
		push: vi.fn(async () => ({ ok: true, refs: {} })),
	}
	mockModule.createGit.mockReturnValue(gitClient)
	const db = createDb()

	const publishedCommit = await syncArtifactSourceSnapshot({
		env: {
			APP_DB: db,
		} as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceId: 'source-1',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'skill',
				title: 'Bootstrap skill',
				description: 'Publishes directly to the source repo',
				entrypoint: 'src/skill.ts',
				sourceRoot: 'src',
			}),
			'src/skill.ts': 'export default async () => "ok"',
		},
	})

	expect(publishedCommit).toBe('commit-bootstrap')
	expect(mockModule.repoSessionRpc).not.toHaveBeenCalled()
	expect(mockModule.resolveArtifactSourceRepo).toHaveBeenCalledWith(
		expect.objectContaining({ APP_DB: expect.anything() }),
		'repo-1',
	)
	expect(mockModule.fsMkdir).toHaveBeenCalledWith('/src', { recursive: true })
	expect(mockModule.fsWriteFile).toHaveBeenCalledWith(
		'/kody.json',
		expect.any(String),
	)
	expect(mockModule.fsWriteFile).toHaveBeenCalledWith(
		'/src/skill.ts',
		'export default async () => "ok"',
	)
	expect(gitClient.init).toHaveBeenCalledWith({
		dir: '/',
		defaultBranch: 'main',
	})
	expect(gitClient.remote).toHaveBeenCalledWith({
		dir: '/',
		add: {
			name: 'origin',
			url: 'https://artifacts.example/repos/repo-1.git',
		},
	})
	expect(gitClient.push).toHaveBeenCalledWith({
		dir: '/',
		remote: 'origin',
		ref: 'main',
		username: 'x',
		password: 'art_v1_write',
	})
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(db, {
		id: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-bootstrap',
		manifestPath: 'kody.json',
		sourceRoot: '/src',
	})
})

test('syncArtifactSourceSnapshot leaves the source row unchanged when bootstrap push fails', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.hasArtifactsAccess.mockReset()
	mockModule.parseArtifactTokenSecret.mockReset()
	mockModule.resolveArtifactSourceRepo.mockReset()
	mockModule.parseRepoManifest.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.createGit.mockReset()
	mockModule.fsMkdir.mockReset()
	mockModule.fsWriteFile.mockReset()

	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.parseArtifactTokenSecret.mockImplementation((token: string) =>
		token.replace(/\?expires=.*$/, ''),
	)
	mockModule.getEntitySourceById.mockResolvedValue(createSource())
	mockModule.parseRepoManifest.mockReturnValue({
		sourceRoot: '/',
	})
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			defaultBranch: 'main',
			remote: 'https://artifacts.example/repos/repo-1.git',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_v1_write?expires=1760000000',
		})),
	})
	mockModule.createGit.mockReturnValue({
		init: vi.fn(async () => ({ initialized: '/' })),
		remote: vi.fn(async () => ({ added: 'origin', url: 'unused' })),
		add: vi.fn(async () => ({ added: '.' })),
		commit: vi.fn(async () => ({
			oid: 'commit-bootstrap',
			message: 'Bootstrap source source-1',
		})),
		push: vi.fn(async () => {
			throw new Error('push failed')
		}),
	})

	await expect(
		syncArtifactSourceSnapshot({
			env: {
				APP_DB: createDb(),
			} as Env,
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			sourceId: 'source-1',
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'skill',
					title: 'Bootstrap skill',
					description: 'Publishes directly to the source repo',
					entrypoint: 'src/skill.ts',
				}),
				'src/skill.ts': 'export default async () => "ok"',
			},
		}),
	).rejects.toThrow('push failed')

	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.repoSessionRpc).not.toHaveBeenCalled()
})

test('syncArtifactSourceSnapshot uses repo sessions for already-published sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.hasArtifactsAccess.mockReset()
	mockModule.resolveArtifactSourceRepo.mockReset()
	mockModule.parseRepoManifest.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.createGit.mockReset()

	mockModule.hasArtifactsAccess.mockReturnValue(true)
	mockModule.getEntitySourceById.mockResolvedValue(
		createSource({ published_commit: 'commit-1' }),
	)

	const sessionClient = {
		openSession: vi.fn(async () => ({ id: 'session-1' })),
		applyEdits: vi.fn(async () => ({ dryRun: false, totalChanged: 2, edits: [] })),
		publishSession: vi.fn(async () => ({
			status: 'ok' as const,
			sessionId: 'session-1',
			publishedCommit: 'commit-2',
			message: 'Published',
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'session-1',
			deleted: true,
		})),
	}
	mockModule.repoSessionRpc.mockReturnValue(sessionClient)

	const publishedCommit = await syncArtifactSourceSnapshot({
		env: {
			APP_DB: createDb(),
			REPO_SESSION: {},
		} as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceId: 'source-1',
		files: {
			'kody.json': '{"version":1}',
			'src/skill.ts': 'export default async () => "ok"',
		},
	})

	expect(publishedCommit).toBe('commit-2')
	expect(mockModule.createGit).not.toHaveBeenCalled()
	expect(mockModule.resolveArtifactSourceRepo).not.toHaveBeenCalled()
	expect(sessionClient.openSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceRoot: '/',
	})
	expect(sessionClient.applyEdits).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'kody.json',
				content: '{"version":1}',
			},
			{
				kind: 'write',
				path: 'src/skill.ts',
				content: 'export default async () => "ok"',
			},
		],
		dryRun: false,
		rollbackOnError: true,
	})
	expect(sessionClient.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
		force: true,
	})
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: 'user-1',
	})
})
