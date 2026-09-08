import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getArtifactsBinding: vi.fn(),
	isArtifactRepoNotFoundError: vi.fn(),
	isLoopbackArtifactsRemote: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	readArtifactFileAtCommit: vi.fn(),
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
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mockModule.resolveExistingArtifactSourceRepo(...args),
}))

vi.mock('./artifact-file.ts', () => ({
	readArtifactFileAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactFileAtCommit(...args),
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

function resetArtifactRepoForkMocks() {
	for (const mock of Object.values(mockModule)) mock.mockReset()
}

test('forkArtifactRepo delegates to the Artifacts binding fork', async () => {
	resetArtifactRepoForkMocks()
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
	resetArtifactRepoForkMocks()
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
	mockModule.updateEntitySource.mockResolvedValue(true)

	const persisted = await persistForkedArtifactRepoContents({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-1',
		source,
		originCommit: 'commit-origin',
		expectedPackageScope: 'jane',
		targetKodyId: 'demo',
		changedFiles: { 'package.json': '{"name":"@jane/demo"}' },
		files: {
			'package.json': '{"name":"@jane/demo"}',
			'poster.png': 'huge-binary',
		},
	})

	expect(persisted).toEqual({
		copiedOriginCommit: 'commit-origin',
		destCommit: 'commit-loopback',
	})
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
	resetArtifactRepoForkMocks()
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-dest.git',
		}),
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(false)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-origin',
	})
	mockModule.updateEntitySource.mockResolvedValue(true)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-edited')

	const persisted = await persistForkedArtifactRepoContents({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-1',
		source,
		originCommit: 'commit-origin',
		expectedPackageScope: 'jane',
		targetKodyId: 'demo',
		changedFiles: { 'package.json': '{"name":"@jane/demo"}' },
		files: {
			'package.json': '{"name":"@jane/demo"}',
			'poster.png': 'huge-binary',
		},
	})

	expect(persisted).toEqual({
		copiedOriginCommit: 'commit-origin',
		destCommit: 'commit-edited',
	})
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
	expect(mockModule.readArtifactFileAtCommit).not.toHaveBeenCalled()
})

test('persistForkedArtifactRepoContents stamps dest HEAD and rewrites only dest package.json when dest HEAD is not the listing pin', async () => {
	resetArtifactRepoForkMocks()
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-dest.git',
		}),
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(false)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head',
	})
	const destHeadManifest = `${JSON.stringify(
		{
			name: '@kody/doom',
			version: '2.0.0',
			kody: { id: 'doom', extra: true },
		},
		null,
		'\t',
	)}\n`
	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode(destHeadManifest),
	)
	mockModule.updateEntitySource.mockResolvedValue(true)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-rewritten')

	const persisted = await persistForkedArtifactRepoContents({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-1',
		source,
		originCommit: 'commit-pin',
		expectedPackageScope: 'jane',
		targetKodyId: 'demo',
		changedFiles: {
			'package.json': '{"name":"@jane/demo","version":"1.0.0"}',
			'README.md': 'rewritten from the listing pin',
		},
		files: {
			'package.json': '{"name":"@jane/demo","version":"1.0.0"}',
			'README.md': 'rewritten from the listing pin',
			'poster.png': 'huge-binary',
		},
	})

	expect(persisted).toEqual({
		copiedOriginCommit: 'commit-head',
		destCommit: 'commit-rewritten',
	})
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({
			publishedCommit: 'commit-head',
		}),
	)
	expect(mockModule.readArtifactFileAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'package-dest',
		commit: 'commit-head',
		filePath: 'package.json',
	})
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: {
				'package.json': `${JSON.stringify(
					{
						name: '@jane/demo',
						version: '2.0.0',
						kody: { id: 'demo', extra: true },
						private: true,
					},
					null,
					'\t',
				)}\n`,
			},
		}),
	)
})

test('persistForkedArtifactRepoContents rejects a forked dest with no HEAD', async () => {
	resetArtifactRepoForkMocks()
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-dest.git',
		}),
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(false)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: null,
	})

	await expect(
		persistForkedArtifactRepoContents({
			env,
			baseUrl: 'https://kody.test',
			userId: 'user-1',
			source,
			originCommit: 'commit-pin',
			expectedPackageScope: 'jane',
			targetKodyId: 'demo',
			changedFiles: { 'package.json': '{"name":"@jane/demo"}' },
			files: { 'package.json': '{"name":"@jane/demo"}' },
		}),
	).rejects.toThrow(/default branch has no HEAD/)
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('persistForkedArtifactRepoContents fails closed when dest published_commit cannot be stamped', async () => {
	resetArtifactRepoForkMocks()
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-dest.git',
		}),
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(false)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head',
	})
	mockModule.updateEntitySource.mockResolvedValue(false)

	await expect(
		persistForkedArtifactRepoContents({
			env,
			baseUrl: 'https://kody.test',
			userId: 'user-1',
			source,
			originCommit: 'commit-head',
			expectedPackageScope: 'jane',
			targetKodyId: 'demo',
			changedFiles: { 'package.json': '{"name":"@jane/demo"}' },
			files: { 'package.json': '{"name":"@jane/demo"}' },
		}),
	).rejects.toThrow(/could not be marked at dest HEAD commit-head/)
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})
