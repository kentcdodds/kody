import { vi } from 'vitest'

export const repoSessionMockModule = (() => {
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
		cloneExternalPublishWorkspace: vi.fn(async () => ({
			workspace: {
				readFile: vi.fn(async () => null),
				glob: vi.fn(async () => []),
			},
			headCommit: 'commit-head',
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
			collectFiles: vi.fn(async () => ({})),
		})),
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
			commit: 'commit-base',
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		})),
		resolveArtifactSourceHead: vi.fn(async () => ({
			branch: 'main',
			commit: 'commit-base',
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
		loadPublishedSourceSnapshot: vi.fn(async () => null),
		loadPublishedSourceManifestSnapshot: vi.fn(async () => null),
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
})()

export function restoreRepoSessionMockBaseline() {
	const { git, gitState } = repoSessionMockModule

	repoSessionMockModule.workspaceExists.mockResolvedValue(false)
	repoSessionMockModule.workspaceReadFile.mockImplementation(
		async (path: string) =>
			repoSessionMockModule.workspaceFiles.get(path) ??
			'{"version":1,"kind":"job","entrypoint":"src/job.ts"}',
	)
	repoSessionMockModule.workspaceWriteFile.mockResolvedValue(undefined)
	repoSessionMockModule.workspaceWriteFileBytes.mockResolvedValue(undefined)
	repoSessionMockModule.workspaceMkdir.mockResolvedValue(undefined)
	repoSessionMockModule.workspaceRm.mockResolvedValue(undefined)
	repoSessionMockModule.workspaceGlob.mockResolvedValue([])
	repoSessionMockModule.cloneExternalPublishWorkspace.mockImplementation(
		async () => ({
			workspace: {
				readFile: vi.fn(async () => null),
				glob: vi.fn(async () => []),
			},
			headCommit: gitState.headCommit,
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
			collectFiles: vi.fn(async () => ({})),
		}),
	)
	repoSessionMockModule.storageGet.mockResolvedValue({
		runId: 'run-1',
		treeHash: '',
		checkedAt: '2026-04-18T00:00:00.000Z',
		ok: true,
		results: [],
	})
	repoSessionMockModule.storagePut.mockResolvedValue(undefined)
	repoSessionMockModule.updateRepoSession.mockResolvedValue(undefined)
	repoSessionMockModule.updateEntitySource.mockResolvedValue(undefined)
	repoSessionMockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
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
	repoSessionMockModule.resolveArtifactDefaultBranchHead.mockResolvedValue({
		defaultBranch: 'main',
		commit: 'commit-base',
		remote: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
	})
	repoSessionMockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-base',
	})
	repoSessionMockModule.parseRepoManifest.mockReturnValue({ sourceRoot: '/' })
	repoSessionMockModule.runRepoChecks.mockResolvedValue({
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
	repoSessionMockModule.writePublishedSourceSnapshot.mockResolvedValue(
		'snapshot-key',
	)
	repoSessionMockModule.loadPublishedSourceSnapshot.mockResolvedValue(null)
	repoSessionMockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue(
		null,
	)
	repoSessionMockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(
		false,
	)
	repoSessionMockModule.persistPublishedPackageArtifactTarget.mockResolvedValue(
		'kv:artifact',
	)
	repoSessionMockModule.registerStorageBucketAndWait.mockClear()
	repoSessionMockModule.maybeRefreshStorageBucketEstimate.mockClear()
	repoSessionMockModule.deleteStorageBucketInventory.mockClear()
	repoSessionMockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'demo',
		sourceId: 'source-1',
	})
	repoSessionMockModule.rawPush.mockResolvedValue({ ok: true, refs: {} })
	repoSessionMockModule.rawPush.mockClear()

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

export function createDurableObjectState() {
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

export function createFakeRepoSessionBlobs(
	initial: Record<string, number> = {},
) {
	const objects = new Map(
		Object.entries(initial).map(([key, size]) => [key, size]),
	)
	const list = vi.fn(async (options: { prefix: string }) => {
		const keys = [...objects.keys()]
			.filter((key) => key.startsWith(options.prefix))
			.sort()
		return {
			objects: keys.map((key) => ({ key, size: objects.get(key) ?? 0 })),
			truncated: false,
		}
	})
	const del = vi.fn(async (keys: string | Array<string>) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			objects.delete(key)
		}
	})
	return {
		objects,
		list,
		delete: del,
		bucket: { list, delete: del } as unknown as R2Bucket,
	}
}

export function createEnv(
	blobs: R2Bucket = createFakeRepoSessionBlobs().bucket,
) {
	return {
		APP_DB: {},
		REPO_SESSION_BLOBS: blobs,
	} as Env
}

export function stubPackageSourceForOpenSession({
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
	repoSessionMockModule.getRepoSessionById.mockResolvedValue(null)
	repoSessionMockModule.getEntitySourceById.mockResolvedValue({
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
	repoSessionMockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
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
		repoSessionMockModule.resolveArtifactDefaultBranchHead.mockResolvedValueOnce(
			null,
		)
	} else {
		repoSessionMockModule.resolveArtifactDefaultBranchHead.mockResolvedValueOnce(
			{
				defaultBranch,
				commit: headCommit,
				remote,
			},
		)
	}
	return { remote }
}

export function setCommonSessionFixtures() {
	restoreRepoSessionMockBaseline()
	repoSessionMockModule.getRepoSessionById.mockResolvedValue({
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
	repoSessionMockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		repo_id: 'source-repo',
		published_commit: 'commit-base',
		manifest_path: 'kody.json',
		source_root: '/',
	})
	repoSessionMockModule.resolveArtifactSourceRepo.mockResolvedValue({
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
	repoSessionMockModule.gitState.currentBranch = 'main'
	repoSessionMockModule.gitState.headCommit = 'commit-head'
	repoSessionMockModule.gitState.statusEntries = []
	repoSessionMockModule.gitState.remotes = [
		{
			remote: 'origin',
			url: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		},
	]
	repoSessionMockModule.git.pull.mockClear()
	repoSessionMockModule.git.push.mockClear()
	repoSessionMockModule.updateRepoSession.mockClear()
	repoSessionMockModule.updateEntitySource.mockClear()
}
