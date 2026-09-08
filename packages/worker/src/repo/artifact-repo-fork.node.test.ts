import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getArtifactsBinding: vi.fn(),
	isArtifactRepoNotFoundError: vi.fn(),
	isLoopbackArtifactsRemote: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	writeArtifactSourceSnapshot: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(),
	updateEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsBinding: (...args: Array<unknown>) =>
		mockModule.getArtifactsBinding(...args),
	isArtifactRepoNotFoundError: (...args: Array<unknown>) =>
		mockModule.isArtifactRepoNotFoundError(...args),
	isLoopbackArtifactsRemote: (...args: Array<unknown>) =>
		mockModule.isLoopbackArtifactsRemote(...args),
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mockModule.resolveExistingArtifactSourceRepo(...args),
}))

vi.mock('./artifact-source-snapshot.ts', () => ({
	writeArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writeArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writePublishedSourceSnapshot(...args),
}))

vi.mock('./entity-sources.ts', () => ({
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('./source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

const { forkArtifactRepo, persistForkedArtifactRepoContents } =
	await import('./artifact-repo-fork.ts')

const env = { APP_DB: {} as D1Database } as Env
const source = {
	id: 'source-1',
	user_id: 'user-1',
	entity_kind: 'package' as const,
	entity_id: 'package-1',
	repo_id: 'package-dest',
	published_commit: null,
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-09-08T00:00:00.000Z',
	updated_at: '2026-09-08T00:00:00.000Z',
}

test('forkArtifactRepo delegates to the Artifacts binding fork', async () => {
	const fork = vi.fn(async () => ({
		id: 'repo_dest',
		name: 'package-dest',
		description: null,
		defaultBranch: 'main',
		remote: 'https://example.test/git/package-dest.git',
		token: 'tok',
		expiresAt: '2026-09-08T01:00:00.000Z',
	}))
	mockModule.getArtifactsBinding.mockReturnValue({ fork })

	await expect(
		forkArtifactRepo({
			env,
			sourceRepoId: 'package-origin',
			targetRepoId: 'package-dest',
		}),
	).resolves.toMatchObject({ name: 'package-dest' })
	expect(fork).toHaveBeenCalledWith('package-origin', 'package-dest', {
		readOnly: false,
		defaultBranchOnly: true,
	})
})

test('persistForkedArtifactRepoContents writes the full rewritten tree on loopback remotes', async () => {
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote: 'http://127.0.0.1:1/git/default/package-dest.git',
		}),
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(true)
	mockModule.writeArtifactSourceSnapshot.mockResolvedValue({
		published_commit: 'commit-loopback',
		files: {},
	})

	const publishedCommit = await persistForkedArtifactRepoContents({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-1',
		source,
		originCommit: 'commit-origin',
		changedFiles: { 'package.json': '{"name":"@jane/demo"}' },
		files: {
			'package.json': '{"name":"@jane/demo"}',
			'poster.png': 'huge-binary',
		},
	})

	expect(publishedCommit).toBe('commit-loopback')
	expect(mockModule.writeArtifactSourceSnapshot).toHaveBeenCalledWith({
		env,
		repoId: 'package-dest',
		files: {
			'package.json': '{"name":"@jane/demo"}',
			'poster.png': 'huge-binary',
		},
	})
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('persistForkedArtifactRepoContents syncs only changed files on production remotes', async () => {
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-dest.git',
		}),
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(false)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-edited')

	const publishedCommit = await persistForkedArtifactRepoContents({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-1',
		source,
		originCommit: 'commit-origin',
		changedFiles: { 'package.json': '{"name":"@jane/demo"}' },
		files: {
			'package.json': '{"name":"@jane/demo"}',
			'poster.png': 'huge-binary',
		},
	})

	expect(publishedCommit).toBe('commit-edited')
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({
			publishedCommit: 'commit-origin',
		}),
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: { 'package.json': '{"name":"@jane/demo"}' },
		}),
	)
})
