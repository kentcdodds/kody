import { expect, test, vi } from 'vitest'
import { createWorkspaceStateBackend } from '@cloudflare/shell'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	repoSessionMockModule as mockModule,
	restoreRepoSessionMockBaseline,
	createDurableObjectState,
	createFakeRepoSessionBlobs,
	createEnv,
	stubPackageSourceForOpenSession,
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
const { deleteRepoSession, insertRepoSession } =
	await import('./repo-sessions.ts')
const { maxRepoSourceFileBytes } = await import('./large-file-policy.ts')

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
			force: true,
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
			force: true,
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
			force: true,
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
	expect(deleteRepoSession).toHaveBeenCalledWith(expect.anything(), {
		userId: 'user-1',
		sessionId: 'session-1',
	})
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		storageId: 'repo-session:session-1',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('repo session remote branch delete failed'),
	)
})

test('session teardown does not wipe blobs without a catalog row and keeps the row when R2 purge fails', async () => {
	restoreRepoSessionMockBaseline()
	const keepKey = 'repo-session:other-do/default/session/pack.pack'
	const sessionKey = 'repo-session:do-session-1/default/session/pack.pack'
	const blobs = createFakeRepoSessionBlobs({
		[sessionKey]: 2_000,
		[keepKey]: 9_000,
	})
	mockModule.getRepoSessionById.mockResolvedValue(null)
	vi.mocked(deleteRepoSession).mockClear()
	const missingRowSession = new RepoSession(
		createDurableObjectState(),
		createEnv(blobs.bucket),
	)

	await expect(
		missingRowSession.discardSession({
			sessionId: 'session-1',
			userId: 'user-1',
		}),
	).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		deleted: false,
	})
	expect([...blobs.objects.keys()].sort()).toEqual([keepKey, sessionKey].sort())
	expect(blobs.list).not.toHaveBeenCalled()
	expect(deleteRepoSession).not.toHaveBeenCalled()

	await expect(
		missingRowSession.cleanupSessionBranch({
			sessionId: 'session-1',
			userId: 'user-1',
			reason: 'expired',
		}),
	).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		branch: '',
		branchDeleted: true,
	})
	expect([...blobs.objects.keys()].sort()).toEqual([keepKey, sessionKey].sort())
	expect(deleteRepoSession).not.toHaveBeenCalled()

	setCommonSessionFixtures()
	const ownedBlobs = createFakeRepoSessionBlobs({
		[sessionKey]: 2_000,
		[keepKey]: 9_000,
	})
	const ownedSession = new RepoSession(
		createDurableObjectState(),
		createEnv(ownedBlobs.bucket),
	)
	await expect(
		ownedSession.discardSession({
			sessionId: 'session-1',
			userId: 'user-1',
		}),
	).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		deleted: true,
	})
	expect(mockModule.updateRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'session-1',
			userId: 'user-1',
			status: 'discarded',
		}),
	)
	expect([...ownedBlobs.objects.keys()]).toEqual([keepKey])

	setCommonSessionFixtures()
	const failingBlobs = createFakeRepoSessionBlobs({
		[sessionKey]: 2_000,
	})
	failingBlobs.list.mockRejectedValueOnce(new Error('R2 list failed'))
	vi.mocked(deleteRepoSession).mockClear()
	const failingSession = new RepoSession(
		createDurableObjectState(),
		createEnv(failingBlobs.bucket),
	)

	await expect(
		failingSession.cleanupSessionBranch({
			sessionId: 'session-1',
			userId: 'user-1',
			reason: 'expired',
		}),
	).rejects.toThrow('R2 list failed')
	expect(deleteRepoSession).not.toHaveBeenCalled()
	expect(mockModule.deleteStorageBucketInventory).not.toHaveBeenCalled()
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

	// in-workspace `..` aliases must collide after normalization.
	await expect(
		repoSession.applyEdits({
			sessionId: 'session-1',
			userId: 'user-1',
			edits: [
				{
					kind: 'write',
					path: 'src/../exports/a.ts',
					content: 'export const a = 2\n',
				},
				{ kind: 'delete', path: 'exports/a.ts' },
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

test('applyEdits composes multiple replace edits to the same file instead of keeping only the last', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/src/ci-secrets.ts') {
			return [
				'const accountId = status.accountId',
				'const value = status.accountId',
				'const extra = status.accountId',
				'',
			].join('\n')
		}
		return ''
	})
	const repoSession = new RepoSession(createDurableObjectState(), createEnv())

	const result = await repoSession.applyEdits({
		sessionId: 'session-1',
		userId: 'user-1',
		edits: [
			{
				kind: 'replace',
				path: 'src/ci-secrets.ts',
				search: 'const accountId = status.accountId',
				replacement: 'const accountId = accountId',
			},
			{
				kind: 'replace',
				path: 'src/ci-secrets.ts',
				search: 'const value = status.accountId',
				replacement: 'const value = accountId',
			},
			{
				kind: 'replace',
				path: 'src/ci-secrets.ts',
				search: 'const extra = status.accountId',
				replacement: 'const extra = accountId',
			},
		],
	})

	// Planner unit tests cover stepwise composition; here assert applyEdits
	// routes through that planner (shell planEdits would keep only the last).
	const composed = [
		'const accountId = accountId',
		'const value = accountId',
		'const extra = accountId',
		'',
	].join('\n')
	const backend = vi.mocked(createWorkspaceStateBackend).mock.results.at(-1)
		?.value as {
		applyEditPlan: ReturnType<typeof vi.fn>
	}
	expect(backend.applyEditPlan).toHaveBeenCalledWith(
		expect.objectContaining({
			totalChanged: 3,
			edits: expect.arrayContaining([
				expect.objectContaining({ changed: true, content: composed }),
			]),
		}),
		expect.objectContaining({ dryRun: undefined }),
	)
	expect(result.totalChanged).toBe(3)
	expect(result.edits.at(-1)?.content).toBe(composed)
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

test('openSession wraps packfile corruption but leaves opaque Cloudflare internals bare', async () => {
	restoreRepoSessionMockBaseline()
	const { remote } = stubPackageSourceForOpenSession()
	mockModule.git.clone.mockRejectedValue(
		new Error(
			'An internal error caused this command to fail. Packfile payload corrupted: calculated abc but expected def.',
		),
	)

	const packfileError = await new RepoSession(
		createDurableObjectState(),
		createEnv(),
	)
		.openSession({
			sessionId: 'session-packfile',
			sourceId: 'source-1',
			userId: 'user-1',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		})
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	expect(packfileError).toBeInstanceOf(Error)
	expect((packfileError as Error).message).toMatch(
		new RegExp(
			`^Artifacts git clone failed for ${remote.replaceAll('.', '\\.')}:`,
		),
	)
	expect((packfileError as Error).message).toContain(
		'Packfile payload corrupted',
	)
	expect(mockModule.git.clone.mock.calls.length).toBeGreaterThanOrEqual(2)

	restoreRepoSessionMockBaseline()
	stubPackageSourceForOpenSession()
	mockModule.git.clone.mockClear()
	mockModule.git.clone.mockRejectedValue(
		new Error('An internal error occurred.'),
	)
	const opaqueError = await new RepoSession(
		createDurableObjectState(),
		createEnv(),
	)
		.openSession({
			sessionId: 'session-opaque',
			sourceId: 'source-1',
			userId: 'user-1',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		})
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	expect(opaqueError).toBeInstanceOf(Error)
	expect((opaqueError as Error).message).toBe('An internal error occurred.')
	expect(mockModule.git.clone).toHaveBeenCalledTimes(1)
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
