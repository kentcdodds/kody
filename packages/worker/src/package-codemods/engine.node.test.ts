import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as RepoChecks from '#worker/repo/checks.ts'
import {
	getPackageCodemodRunById,
	listPackageCodemodRunItems,
} from './ledger.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	listSavedPackagesPage: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	runRepoChecks: vi.fn(),
	dispatchPackageCodemodSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mocks.listSavedPackagesByUserId(...args),
	listSavedPackagesPage: (...args: Array<unknown>) =>
		mocks.listSavedPackagesPage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mocks.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mocks.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mocks.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mocks.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/checks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RepoChecks>()
	return {
		...actual,
		runRepoChecks: (...args: Array<unknown>) => mocks.runRepoChecks(...args),
	}
})

vi.mock('./subscription-events.ts', () => ({
	packageCodemodAppliedTopic: 'package.codemod.applied',
	packageCodemodRevertedTopic: 'package.codemod.reverted',
	dispatchPackageCodemodSubscriptionEvent: (...args: Array<unknown>) =>
		mocks.dispatchPackageCodemodSubscriptionEvent(...args),
}))

const { runPackageCodemodStep } = await import('./engine.ts')

const codemodId = '0001-ambient-storage-to-package-storage'

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		namespace: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function createEngineDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0111-package-codemod-ledger.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return createD1FromSqlite(sqlite)
}

function createEnv() {
	const kv = createKv()
	return {
		env: {
			APP_DB: createEngineDb(),
			BUNDLE_ARTIFACTS_KV: kv.namespace,
			APP_BASE_URL: 'https://example.com',
		} as Env,
		kv,
	}
}

function savedPackage(input: {
	id: string
	userId: string
	kodyId: string
	sourceId: string
}) {
	return {
		id: input.id,
		userId: input.userId,
		name: `@${input.userId}/${input.kodyId}`,
		kodyId: input.kodyId,
		description: input.kodyId,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		hidden: false,
		isPrivate: true,
		createdAt: '2026-07-30T00:00:00.000Z',
		updatedAt: '2026-07-30T00:00:00.000Z',
	}
}

function ambientFiles(extra?: Record<string, string>) {
	return {
		'package.json': `${JSON.stringify(
			{
				name: '@user/demo',
				exports: { '.': './index.ts' },
				kody: { id: 'demo', description: 'Demo package for codemod tests.' },
			},
			null,
			'\t',
		)}\n`,
		'index.ts':
			"import { storage } from 'kody:runtime'\nexport async function run() {\n\treturn storage.get('k')\n}\n",
		...extra,
	}
}

function cleanFiles() {
	return {
		'package.json': `${JSON.stringify(
			{
				name: '@user/clean',
				exports: { '.': './index.ts' },
				kody: { id: 'clean', description: 'Clean package for codemod tests.' },
			},
			null,
			'\t',
		)}\n`,
		'index.ts':
			"import { packageStorage } from 'kody:runtime'\nconst storage = packageStorage()\nexport async function run() {\n\treturn storage.get('k')\n}\n",
	}
}

function loadedSource(input: {
	files: Record<string, string>
	publishedCommit: string | null
	repoId?: string
	sourceId?: string
	userId?: string
}) {
	return {
		source: {
			id: input.sourceId ?? 'source-1',
			user_id: input.userId ?? 'user-1',
			entity_kind: 'package',
			repo_id: input.repoId ?? 'repo-1',
			published_commit: input.publishedCommit,
			indexed_commit: input.publishedCommit,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-07-30T00:00:00.000Z',
			updated_at: '2026-07-30T00:00:00.000Z',
		},
		files: input.files,
		manifest: {},
	}
}

function resetMocks() {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.listSavedPackagesPage.mockReset()
	mocks.loadPackageSourceBySourceId.mockReset()
	mocks.syncArtifactSourceSnapshot.mockReset()
	mocks.refreshSavedPackageProjection.mockReset()
	mocks.resolveArtifactSourceHead.mockReset()
	mocks.runRepoChecks.mockReset()
	mocks.dispatchPackageCodemodSubscriptionEvent.mockReset()
	mocks.refreshSavedPackageProjection.mockResolvedValue(undefined)
	mocks.dispatchPackageCodemodSubscriptionEvent.mockResolvedValue([])
	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => ({
			branch: 'main',
			commit: `commit-${repoId}`,
		}),
	)
	mocks.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'lint', ok: true, message: 'ok' }],
		manifest: {},
		sourceFiles: {},
	})
	mocks.syncArtifactSourceSnapshot.mockImplementation(
		async (input: { files: Record<string, string> }) => {
			const marker = input.files['index.ts']?.includes('packageStorage')
				? 'after'
				: 'reverted'
			return `commit-${marker}`
		},
	)
}

test('package codemod engine covers scan dry-run apply revert drift unpublished isolation and gates', async () => {
	resetMocks()
	const { env, kv } = createEnv()

	const pkgAmbient = savedPackage({
		id: 'pkg-ambient',
		userId: 'user-1',
		kodyId: 'ambient',
		sourceId: 'source-ambient',
	})
	const pkgClean = savedPackage({
		id: 'pkg-clean',
		userId: 'user-1',
		kodyId: 'clean',
		sourceId: 'source-clean',
	})
	const pkgDrift = savedPackage({
		id: 'pkg-drift',
		userId: 'user-1',
		kodyId: 'drift',
		sourceId: 'source-drift',
	})
	const pkgUnpublished = savedPackage({
		id: 'pkg-unpublished',
		userId: 'user-1',
		kodyId: 'unpublished',
		sourceId: 'source-unpublished',
	})
	const pkgFail = savedPackage({
		id: 'pkg-fail',
		userId: 'user-1',
		kodyId: 'fail',
		sourceId: 'source-fail',
	})
	const pkgOtherUser = savedPackage({
		id: 'pkg-other',
		userId: 'user-2',
		kodyId: 'other',
		sourceId: 'source-other',
	})

	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) => {
			if (input.userId === 'user-1') {
				return [pkgAmbient, pkgClean, pkgDrift, pkgUnpublished, pkgFail]
			}
			if (input.userId === 'user-2') {
				return [pkgOtherUser]
			}
			return []
		},
	)
	mocks.listSavedPackagesPage.mockResolvedValue([])

	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string; userId: string }) => {
			if (input.sourceId === 'source-fail') {
				throw new Error('source boom')
			}
			if (input.sourceId === 'source-unpublished') {
				return loadedSource({
					files: ambientFiles(),
					publishedCommit: null,
					repoId: 'repo-unpublished',
					sourceId: input.sourceId,
					userId: input.userId,
				})
			}
			if (input.sourceId === 'source-drift') {
				return loadedSource({
					files: ambientFiles(),
					publishedCommit: 'commit-published-old',
					repoId: 'repo-drift',
					sourceId: input.sourceId,
					userId: input.userId,
				})
			}
			if (input.sourceId === 'source-clean') {
				return loadedSource({
					files: cleanFiles(),
					publishedCommit: 'commit-repo-clean',
					repoId: 'repo-clean',
					sourceId: input.sourceId,
					userId: input.userId,
				})
			}
			if (input.sourceId === 'source-other') {
				return loadedSource({
					files: ambientFiles(),
					publishedCommit: 'commit-repo-other',
					repoId: 'repo-other',
					sourceId: input.sourceId,
					userId: input.userId,
				})
			}
			return loadedSource({
				files: ambientFiles(),
				publishedCommit: 'commit-repo-ambient',
				repoId: 'repo-ambient',
				sourceId: input.sourceId,
				userId: input.userId,
			})
		},
	)

	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => {
			if (repoId === 'repo-drift') {
				return { branch: 'main', commit: 'commit-head-moved' }
			}
			return { branch: 'main', commit: `commit-${repoId}` }
		},
	)

	const scan = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		limit: 50,
	})
	expect(scan.nextCursor).toBeNull()
	expect(scan.summary).toMatchObject({
		detected: 1,
		clean: 1,
		skipped_drift: 1,
		skipped_unpublished: 1,
		failed: 1,
	})
	const scanByPackage = Object.fromEntries(
		scan.items.map((item) => [item.packageId, item.status]),
	)
	expect(scanByPackage).toMatchObject({
		'pkg-ambient': 'detected',
		'pkg-clean': 'clean',
		'pkg-drift': 'skipped_drift',
		'pkg-unpublished': 'skipped_unpublished',
		'pkg-fail': 'failed',
	})
	expect(
		scan.items.find((item) => item.packageId === 'pkg-fail')?.error,
	).toContain('source boom')
	expect(await getPackageCodemodRunById(env.APP_DB, scan.runId)).toMatchObject({
		status: 'completed',
		scopeUserId: 'user-1',
	})

	mocks.runRepoChecks.mockImplementation(
		async (input: {
			workspace: { readFile(path: string): Promise<string | null> }
		}) => {
			const index = await input.workspace.readFile('index.ts')
			const hasAmbient =
				typeof index === 'string' &&
				/import\s*\{[^}]*\bstorage\b/.test(index) &&
				index.includes("from 'kody:runtime'")
			if (hasAmbient) {
				return {
					ok: false,
					results: [
						{
							kind: 'lint',
							ok: false,
							message: 'ambient storage',
						},
					],
					manifest: {},
					sourceFiles: {},
				}
			}
			return {
				ok: true,
				results: [{ kind: 'lint', ok: true, message: 'ok' }],
				manifest: {},
				sourceFiles: {},
			}
		},
	)

	const dryRun = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'dry-run',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-ambient', 'pkg-clean'] },
		limit: 50,
	})
	expect(dryRun.summary).toMatchObject({
		dry_run_ok: 1,
		clean: 1,
	})
	expect(
		dryRun.items.find((item) => item.packageId === 'pkg-ambient'),
	).toMatchObject({
		status: 'dry_run_ok',
		changedPaths: ['index.ts'],
		checkSummary: { ok: true, newFailures: [] },
	})
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	mocks.runRepoChecks.mockImplementation(
		async (input: {
			workspace: { readFile(path: string): Promise<string | null> }
		}) => {
			const index = await input.workspace.readFile('index.ts')
			const transformed =
				typeof index === 'string' &&
				index.includes('const storage = packageStorage()')
			if (transformed) {
				return {
					ok: false,
					results: [
						{
							kind: 'lint',
							ok: false,
							message: 'new failure only after transform',
						},
					],
					manifest: {},
					sourceFiles: {},
				}
			}
			return {
				ok: true,
				results: [{ kind: 'lint', ok: true, message: 'ok' }],
				manifest: {},
				sourceFiles: {},
			}
		},
	)
	const gated = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-ambient'] },
		limit: 50,
	})
	expect(gated.items).toHaveLength(1)
	expect(gated.items[0]?.status).toBe('dry_run_new_failures')
	expect(gated.items[0]?.checkSummary?.newFailures).toEqual([
		'lint:new failure only after transform',
	])
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	mocks.runRepoChecks.mockImplementation(
		async (input: {
			workspace: { readFile(path: string): Promise<string | null> }
		}) => {
			const index = await input.workspace.readFile('index.ts')
			const hasAmbient =
				typeof index === 'string' &&
				/import\s*\{[^}]*\bstorage\b/.test(index) &&
				!index.includes('packageStorage')
			if (hasAmbient) {
				return {
					ok: false,
					results: [{ kind: 'lint', ok: false, message: 'ambient storage' }],
					manifest: {},
					sourceFiles: {},
				}
			}
			return {
				ok: true,
				results: [{ kind: 'lint', ok: true, message: 'ok' }],
				manifest: {},
				sourceFiles: {},
			}
		},
	)

	const apply = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-ambient'] },
		limit: 50,
	})
	expect(apply.items).toHaveLength(1)
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: 'pkg-ambient',
		beforeCommit: 'commit-repo-ambient',
		afterCommit: 'commit-after',
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-ambient',
			destructiveOverwriteConfirmed: true,
			commitMessage: expect.stringContaining(`codemod(${codemodId})`),
			files: expect.objectContaining({
				'index.ts': expect.stringContaining('packageStorage'),
			}),
		}),
	)
	const applyItemId = apply.items[0]!.itemId
	const revertKey = `package-codemod-revert:${applyItemId}`
	const snapshotRaw = await env.BUNDLE_ARTIFACTS_KV.get(revertKey)
	expect(snapshotRaw).toBeTruthy()
	const snapshot = JSON.parse(snapshotRaw!) as {
		files: Record<string, string>
		beforeCommit: string
	}
	expect(snapshot.beforeCommit).toBe('commit-repo-ambient')
	expect(snapshot.files['index.ts']).toContain(
		"import { storage } from 'kody:runtime'",
	)
	expect(mocks.dispatchPackageCodemodSubscriptionEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			topic: 'package.codemod.applied',
			packageId: 'pkg-ambient',
			itemId: applyItemId,
		}),
	)

	const ledgerItems = await listPackageCodemodRunItems(env.APP_DB, {
		runId: apply.runId,
		limit: 10,
	})
	expect(ledgerItems).toHaveLength(1)
	expect(ledgerItems[0]?.status).toBe('applied')

	const otherUserApply = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-2',
		codemodId,
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-2' },
		filters: { packageIds: ['pkg-ambient'] },
		limit: 50,
	})
	expect(otherUserApply.items).toEqual([])
	expect(otherUserApply.summary).toEqual({})

	const user1CannotSeeUser2 = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-other'] },
		limit: 50,
	})
	expect(user1CannotSeeUser2.items).toEqual([])

	const revert = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		revertOfRunId: apply.runId,
		limit: 50,
	})
	expect(revert.items).toHaveLength(1)
	expect(revert.items[0]).toMatchObject({
		status: 'reverted',
		packageId: 'pkg-ambient',
		afterCommit: 'commit-reverted',
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: expect.objectContaining({
				'index.ts': expect.stringContaining(
					"import { storage } from 'kody:runtime'",
				),
			}),
			commitMessage: `revert codemod(${codemodId})`,
		}),
	)
	expect(mocks.dispatchPackageCodemodSubscriptionEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			topic: 'package.codemod.reverted',
			packageId: 'pkg-ambient',
		}),
	)

	const user2CannotRevertUser1 = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-2',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-2' },
		revertOfRunId: apply.runId,
		limit: 50,
	})
	expect(user2CannotRevertUser1.items).toEqual([])

	expect(kv.store.has(revertKey)).toBe(true)
})
