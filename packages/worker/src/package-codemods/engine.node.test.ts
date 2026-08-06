import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as RepoChecks from '#worker/repo/checks.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunById,
	getPackageCodemodRunItemById,
	insertPackageCodemodRunItem,
	listPackageCodemodRunItems,
	listPackageCodemodRuns,
	packageCodemodLedgerTextBounds,
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
	createPackageCodemodSubscriptionCache: () => ({
		load: async () => ({ subscriptions: [], discoveryErrors: [] }),
	}),
	dispatchPackageCodemodSubscriptionEvent: (...args: Array<unknown>) =>
		mocks.dispatchPackageCodemodSubscriptionEvent(...args),
}))

const { buildPackageCodemodRevertSnapshotKvKey, runPackageCodemodStep } =
	await import('./engine.ts')

const codemodId = '0001-ambient-storage-to-package-storage'

function createKv() {
	const store = new Map<string, { value: string; expirationTtl?: number }>()
	return {
		store,
		namespace: {
			async get(key: string) {
				return store.get(key)?.value ?? null
			},
			async put(
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			) {
				store.set(key, { value, expirationTtl: options?.expirationTtl })
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function createEngineDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
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

function ambientFiles() {
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
			"import { packageStorage } from 'kody:runtime'\nexport async function run() {\n\treturn packageStorage().get('k')\n}\n",
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
			const marker = input.files['index.ts']?.includes('packageStorage()')
				? 'after'
				: 'reverted'
			return `commit-${marker}`
		},
	)
}

test('package codemod engine covers lifecycle, drift, isolation, snapshot keys, and gates', async () => {
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
						{ kind: 'lint', ok: false, message: 'ambient storage line 12' },
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
		limit: 10,
	})
	expect(dryRun.summary).toMatchObject({
		dry_run_ok: 1,
		clean: 1,
	})
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	mocks.runRepoChecks.mockImplementation(
		async (input: {
			workspace: { readFile(path: string): Promise<string | null> }
		}) => {
			const index = await input.workspace.readFile('index.ts')
			const transformed =
				typeof index === 'string' && index.includes('packageStorage().get')
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
		limit: 10,
	})
	expect(gated.items[0]?.status).toBe('dry_run_new_failures')
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
					results: [
						{ kind: 'lint', ok: false, message: 'ambient storage line 12' },
					],
					manifest: {},
					sourceFiles: {},
				}
			}
			return {
				ok: false,
				results: [
					{ kind: 'lint', ok: false, message: 'ambient storage line 40' },
				],
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
		limit: 10,
	})
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: 'pkg-ambient',
		beforeCommit: 'commit-repo-ambient',
		afterCommit: 'commit-after',
	})
	const applyItemId = apply.items[0]!.itemId
	const revertKey = buildPackageCodemodRevertSnapshotKvKey({
		userId: 'user-1',
		itemId: applyItemId,
	})
	expect(revertKey).toBe(`package-codemod-revert:user-1:${applyItemId}`)
	const stored = kv.store.get(revertKey)
	expect(stored?.expirationTtl).toBe(90 * 24 * 60 * 60)
	const ledgerItem = await getPackageCodemodRunItemById(env.APP_DB, applyItemId)
	expect(ledgerItem?.revertSnapshotKey).toBe(revertKey)
	expect(mocks.dispatchPackageCodemodSubscriptionEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			topic: 'package.codemod.applied',
			subscriptionCache: expect.anything(),
		}),
	)

	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => {
			if (repoId === 'repo-ambient') {
				return { branch: 'main', commit: 'commit-after' }
			}
			if (repoId === 'repo-drift') {
				return { branch: 'main', commit: 'commit-head-moved' }
			}
			return { branch: 'main', commit: `commit-${repoId}` }
		},
	)

	const revert = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		revertOfRunId: apply.runId,
		limit: 10,
	})
	expect(revert.items[0]?.status).toBe('reverted')
	const sourceAfterRevert = await getPackageCodemodRunItemById(
		env.APP_DB,
		applyItemId,
	)
	expect(sourceAfterRevert?.status).toBe('reverted')

	const secondRevert = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		revertOfRunId: apply.runId,
		limit: 10,
	})
	expect(secondRevert.items).toEqual([])

	const user2CannotRevertUser1 = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-2',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-2' },
		revertOfRunId: apply.runId,
		limit: 10,
	})
	expect(user2CannotRevertUser1.items).toEqual([])
})

test('package codemod engine enforces resume scope, binary paging, fleet progress, and publish failure id reuse', async () => {
	resetMocks()
	const { env, kv } = createEnv()

	const pkgA = savedPackage({
		id: 'a',
		userId: 'user-1',
		kodyId: 'a',
		sourceId: 'source-a',
	})
	const pkgB = savedPackage({
		id: 'B',
		userId: 'user-1',
		kodyId: 'b',
		sourceId: 'source-b',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkgA, pkgB])
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string; userId: string }) =>
			loadedSource({
				files: cleanFiles(),
				publishedCommit: `commit-${input.sourceId}`,
				repoId: input.sourceId,
				sourceId: input.sourceId,
				userId: input.userId,
			}),
	)
	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => ({
			branch: 'main',
			commit: `commit-${repoId}`,
		}),
	)

	const firstPage = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		limit: 1,
	})
	expect(firstPage.items.map((item) => item.packageId)).toEqual(['B'])
	expect(firstPage.nextCursor).toBe('B')
	const secondPage = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		runId: firstPage.runId,
		cursor: firstPage.nextCursor,
		limit: 1,
	})
	expect(secondPage.items.map((item) => item.packageId)).toEqual(['a'])
	expect(secondPage.nextCursor).toBeNull()

	await expect(
		runPackageCodemodStep({
			env,
			baseUrl: 'https://example.com',
			initiatedByUserId: 'user-1',
			codemodId,
			mode: 'scan',
			scope: { kind: 'fleet' },
			runId: firstPage.runId,
			limit: 1,
		}),
	).rejects.toThrow(/scope does not match/i)

	mocks.listSavedPackagesPage.mockImplementation(
		async (
			_db: D1Database,
			input: { afterId: string | null; limit: number },
		) => {
			const start = input.afterId
				? Number(input.afterId.split('-').at(-1)) + 1
				: 1
			if (start > 250) return []
			return Array.from({ length: input.limit }, (_, index) => {
				const n = start + index
				return savedPackage({
					id: `fleet-${String(n).padStart(4, '0')}`,
					userId: 'user-9',
					kodyId: `nope-${n}`,
					sourceId: `source-fleet-${n}`,
				})
			})
		},
	)
	const fleetFiltered = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'admin-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'fleet' },
		filters: { packageIds: ['never-match'] },
		limit: 5,
	})
	expect(fleetFiltered.items).toEqual([])
	expect(fleetFiltered.nextCursor).toBe('fleet-0250')
	expect(mocks.listSavedPackagesPage.mock.calls.length).toBe(5)

	const pkgPublish = savedPackage({
		id: 'pkg-publish',
		userId: 'user-1',
		kodyId: 'publish',
		sourceId: 'source-publish',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkgPublish])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: ambientFiles(),
			publishedCommit: 'commit-repo-publish',
			repoId: 'repo-publish',
			sourceId: 'source-publish',
			userId: 'user-1',
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-repo-publish',
	})
	mocks.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'lint', ok: true, message: 'ok' }],
		manifest: {},
		sourceFiles: {},
	})
	mocks.syncArtifactSourceSnapshot.mockRejectedValueOnce(
		new Error('publish exploded'),
	)
	const failedPublish = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-publish'] },
		limit: 10,
	})
	expect(failedPublish.items).toHaveLength(1)
	expect(failedPublish.items[0]?.status).toBe('failed')
	expect(failedPublish.items[0]?.error).toMatch(/repo HEAD may be ahead/i)
	const failedItem = await getPackageCodemodRunItemById(
		env.APP_DB,
		failedPublish.items[0]!.itemId,
	)
	expect(failedItem?.revertSnapshotKey).toBe(
		buildPackageCodemodRevertSnapshotKvKey({
			userId: 'user-1',
			itemId: failedPublish.items[0]!.itemId,
		}),
	)
	expect(kv.store.has(failedItem!.revertSnapshotKey!)).toBe(true)

	let headCalls = 0
	mocks.syncArtifactSourceSnapshot.mockReset()
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-after')
	mocks.resolveArtifactSourceHead.mockImplementation(async () => {
		headCalls += 1
		if (headCalls >= 2) {
			return { branch: 'main', commit: 'commit-moved-before-publish' }
		}
		return { branch: 'main', commit: 'commit-repo-publish' }
	})
	const driftBeforePublish = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-publish'] },
		limit: 10,
	})
	expect(driftBeforePublish.items[0]?.status).toBe('skipped_drift')
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('package codemod revert skips when HEAD no longer matches applied afterCommit', async () => {
	resetMocks()
	const { env } = createEnv()
	const pkg = savedPackage({
		id: 'pkg-revert-drift',
		userId: 'user-1',
		kodyId: 'revert-drift',
		sourceId: 'source-revert-drift',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: ambientFiles(),
			publishedCommit: 'commit-repo-revert-drift',
			repoId: 'repo-revert-drift',
			sourceId: 'source-revert-drift',
			userId: 'user-1',
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-repo-revert-drift',
	})
	mocks.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'lint', ok: true, message: 'ok' }],
		manifest: {},
		sourceFiles: {},
	})
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-after-apply')

	const apply = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-1' },
		limit: 10,
	})
	expect(apply.items[0]?.status).toBe('applied')

	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-user-moved-head',
	})
	const revert = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		revertOfRunId: apply.runId,
		limit: 10,
	})
	expect(revert.items[0]?.status).toBe('skipped_drift')
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
})

test('package codemod ledger bounds stored JSON/text columns', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const { createPackageCodemodRun, insertPackageCodemodRunItem } =
		await import('./ledger.ts')
	await createPackageCodemodRun(db, {
		id: 'run-bound',
		codemodId,
		mode: 'scan',
		scopeUserId: 'user-1',
		initiatedByUserId: 'admin',
	})
	const hugePaths = Array.from(
		{ length: 500 },
		(_, index) => `path-${index}-${'x'.repeat(200)}`,
	)
	const hugeFindings = Array.from({ length: 200 }, (_, index) => ({
		path: `file-${index}.ts`,
		message: 'm'.repeat(2_000),
	}))
	const item = await insertPackageCodemodRunItem(db, {
		id: 'item-bound',
		runId: 'run-bound',
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'one',
		status: 'detected',
		changedPaths: hugePaths,
		findings: hugeFindings,
		checkSummaryJson: JSON.stringify({
			ok: false,
			newFailures: ['x'.repeat(100_000)],
		}),
		error: 'e'.repeat(100_000),
		revertSnapshotKey: 'package-codemod-revert:user-1:item-bound',
	})
	expect(
		new TextEncoder().encode(JSON.stringify(item.changedPaths)).byteLength,
	).toBeLessThanOrEqual(
		packageCodemodLedgerTextBounds.maxRestorableTextColumnBytes,
	)
	expect(
		new TextEncoder().encode(JSON.stringify(item.findings)).byteLength,
	).toBeLessThanOrEqual(
		packageCodemodLedgerTextBounds.maxRestorableTextColumnBytes,
	)
	expect(item.error?.includes('[truncated]')).toBe(true)
	expect(item.revertSnapshotKey).toBe(
		'package-codemod-revert:user-1:item-bound',
	)
	const listed = await listPackageCodemodRunItems(db, {
		runId: 'run-bound',
		limit: 10,
	})
	expect(listed[0]?.revertSnapshotKey).toBe(
		'package-codemod-revert:user-1:item-bound',
	)
	expect(await getPackageCodemodRunById(db, 'run-bound')).toMatchObject({
		id: 'run-bound',
	})
})

test('package codemod engine rejects resume steps with mismatched filters', async () => {
	resetMocks()
	const { env } = createEnv()
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		savedPackage({
			id: 'pkg-a',
			userId: 'user-1',
			kodyId: 'a',
			sourceId: 'source-a',
		}),
	])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: cleanFiles(),
			publishedCommit: 'commit-a',
			repoId: 'repo-a',
			sourceId: 'source-a',
			userId: 'user-1',
		}),
	)

	const first = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'admin-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-a', 'pkg-b'] },
		limit: 10,
	})
	expect(first.runId).toBeTruthy()

	await expect(
		runPackageCodemodStep({
			env,
			baseUrl: 'https://example.com',
			initiatedByUserId: 'admin-2',
			codemodId,
			mode: 'scan',
			scope: { kind: 'user', userId: 'user-1' },
			runId: first.runId,
			filters: { packageIds: ['pkg-other'] },
			limit: 10,
		}),
	).rejects.toThrow(/filters do not match/i)

	const resumed = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'admin-2',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		runId: first.runId,
		filters: { packageIds: ['pkg-b', 'pkg-a'] },
		limit: 10,
	})
	expect(resumed.runId).toBe(first.runId)
})

test('package codemod revert page ceiling and user-scoped SQL filter for sparse ownership', async () => {
	resetMocks()
	const { env } = createEnv()

	await createPackageCodemodRun(env.APP_DB, {
		id: 'prior-fleet',
		codemodId,
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		status: 'completed',
	})

	for (let index = 0; index < 40; index += 1) {
		await insertPackageCodemodRunItem(env.APP_DB, {
			id: `other-${String(index).padStart(4, '0')}`,
			runId: 'prior-fleet',
			userId: 'user-other',
			packageId: `pkg-other-${index}`,
			kodyId: `other-${index}`,
			status: 'applied',
			beforeCommit: 'before',
			afterCommit: 'after',
		})
	}
	await insertPackageCodemodRunItem(env.APP_DB, {
		id: 'mine-0001',
		runId: 'prior-fleet',
		userId: 'user-1',
		packageId: 'pkg-mine-1',
		kodyId: 'mine-1',
		status: 'applied',
		beforeCommit: 'before',
		afterCommit: 'after',
	})
	await insertPackageCodemodRunItem(env.APP_DB, {
		id: 'mine-0002',
		runId: 'prior-fleet',
		userId: 'user-1',
		packageId: 'pkg-mine-2',
		kodyId: 'mine-2',
		status: 'applied',
		beforeCommit: 'before',
		afterCommit: 'after',
	})

	const sparse = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		revertOfRunId: 'prior-fleet',
		limit: 10,
	})
	expect(sparse.items).toHaveLength(2)
	expect(sparse.items.every((item) => item.userId === 'user-1')).toBe(true)
	expect(sparse.nextCursor).toBeNull()
	expect(
		await getPackageCodemodRunById(env.APP_DB, sparse.runId),
	).toMatchObject({
		status: 'completed',
	})

	await createPackageCodemodRun(env.APP_DB, {
		id: 'prior-dense',
		codemodId,
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		status: 'completed',
	})
	// More applied rows than one heavy step can finish (step limit caps at 10)
	// so the revert must return a cursor instead of completing the run.
	for (let index = 0; index < 30; index += 1) {
		await insertPackageCodemodRunItem(env.APP_DB, {
			id: `dense-${String(index).padStart(4, '0')}`,
			runId: 'prior-dense',
			userId: 'user-1',
			packageId: `pkg-dense-${index}`,
			kodyId: `dense-${index}`,
			status: 'applied',
			beforeCommit: 'before',
			afterCommit: 'after',
		})
	}

	const paged = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		revertOfRunId: 'prior-dense',
		limit: 10,
	})
	expect(paged.items).toHaveLength(10)
	expect(paged.nextCursor).toBe('dense-0009')
	expect(await getPackageCodemodRunById(env.APP_DB, paged.runId)).toMatchObject(
		{
			status: 'running',
		},
	)
})

test('package codemod fleet revert applies packageIds filters and leaves others applied', async () => {
	resetMocks()
	const { env, kv } = createEnv()

	await createPackageCodemodRun(env.APP_DB, {
		id: 'prior-canary-apply',
		codemodId,
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		status: 'completed',
	})

	const priorItems = [
		{
			id: 'item-pkg-keep-a',
			userId: 'user-1',
			packageId: 'pkg-keep-a',
			kodyId: 'keep-a',
			sourceId: 'source-keep-a',
			repoId: 'repo-keep-a',
		},
		{
			id: 'item-pkg-revert',
			userId: 'user-1',
			packageId: 'pkg-revert-me',
			kodyId: 'revert-me',
			sourceId: 'source-revert',
			repoId: 'repo-revert',
		},
		{
			id: 'item-pkg-keep-b',
			userId: 'user-2',
			packageId: 'pkg-keep-b',
			kodyId: 'keep-b',
			sourceId: 'source-keep-b',
			repoId: 'repo-keep-b',
		},
	] as const

	for (const prior of priorItems) {
		const revertSnapshotKey = buildPackageCodemodRevertSnapshotKvKey({
			userId: prior.userId,
			itemId: prior.id,
		})
		await insertPackageCodemodRunItem(env.APP_DB, {
			id: prior.id,
			runId: 'prior-canary-apply',
			userId: prior.userId,
			packageId: prior.packageId,
			kodyId: prior.kodyId,
			status: 'applied',
			beforeCommit: `commit-${prior.repoId}-before`,
			afterCommit: `commit-${prior.repoId}-after`,
			changedPaths: ['index.ts'],
			revertSnapshotKey,
		})
		await kv.namespace.put(
			revertSnapshotKey,
			JSON.stringify({
				codemodId,
				userId: prior.userId,
				packageId: prior.packageId,
				beforeCommit: `commit-${prior.repoId}-before`,
				files: cleanFiles(),
			}),
		)
	}

	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) =>
			priorItems
				.filter((prior) => prior.userId === input.userId)
				.map((prior) =>
					savedPackage({
						id: prior.packageId,
						userId: prior.userId,
						kodyId: prior.kodyId,
						sourceId: prior.sourceId,
					}),
				),
	)
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string; userId: string }) => {
			const prior = priorItems.find(
				(candidate) => candidate.sourceId === input.sourceId,
			)
			if (!prior) throw new Error(`unexpected source ${input.sourceId}`)
			return loadedSource({
				files: cleanFiles(),
				publishedCommit: `commit-${prior.repoId}-after`,
				repoId: prior.repoId,
				sourceId: prior.sourceId,
				userId: prior.userId,
			})
		},
	)
	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => ({
			branch: 'main',
			commit: `commit-${repoId}-after`,
		}),
	)
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-reverted')

	const revert = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'admin-1',
		codemodId,
		mode: 'revert',
		scope: { kind: 'fleet' },
		filters: { packageIds: ['pkg-revert-me'] },
		revertOfRunId: 'prior-canary-apply',
		limit: 10,
	})
	expect(revert.items).toHaveLength(1)
	expect(revert.items[0]).toMatchObject({
		packageId: 'pkg-revert-me',
		status: 'reverted',
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)

	expect(
		await getPackageCodemodRunItemById(env.APP_DB, 'item-pkg-revert'),
	).toMatchObject({ status: 'reverted' })
	expect(
		await getPackageCodemodRunItemById(env.APP_DB, 'item-pkg-keep-a'),
	).toMatchObject({ status: 'applied' })
	expect(
		await getPackageCodemodRunItemById(env.APP_DB, 'item-pkg-keep-b'),
	).toMatchObject({ status: 'applied' })
})

test('package codemod step-level throw marks the run failed instead of leaving it running', async () => {
	resetMocks()
	const { env } = createEnv()
	mocks.listSavedPackagesPage.mockRejectedValue(new Error('paging boom'))

	await expect(
		runPackageCodemodStep({
			env,
			baseUrl: 'https://example.com',
			initiatedByUserId: 'admin-1',
			codemodId,
			mode: 'scan',
			scope: { kind: 'fleet' },
			limit: 5,
		}),
	).rejects.toThrow('paging boom')

	// The step threw before returning a runId, so look the run up directly.
	const runs = await listPackageCodemodRuns(env.APP_DB, { limit: 10 })
	expect(runs).toHaveLength(1)
	expect(runs[0]).toMatchObject({ status: 'failed' })
})

test('package codemod continuation steps heartbeat the run and reopen abandoned runs', async () => {
	resetMocks()
	const { env } = createEnv()
	const pkgA = savedPackage({
		id: 'hb-a',
		userId: 'user-1',
		kodyId: 'hb-a',
		sourceId: 'source-hb-a',
	})
	const pkgB = savedPackage({
		id: 'hb-b',
		userId: 'user-1',
		kodyId: 'hb-b',
		sourceId: 'source-hb-b',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkgA, pkgB])
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string; userId: string }) =>
			loadedSource({
				files: cleanFiles(),
				publishedCommit: `commit-${input.sourceId}`,
				repoId: input.sourceId,
				sourceId: input.sourceId,
				userId: input.userId,
			}),
	)

	await createPackageCodemodRun(env.APP_DB, {
		id: 'run-heartbeat',
		codemodId,
		mode: 'scan',
		scopeUserId: 'user-1',
		initiatedByUserId: 'admin-1',
		status: 'abandoned',
		createdAt: '2026-07-30T10:00:00.000Z',
		updatedAt: '2026-07-30T10:00:00.000Z',
	})

	const step = await runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'admin-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'user', userId: 'user-1' },
		runId: 'run-heartbeat',
		limit: 1,
	})
	expect(step.nextCursor).not.toBeNull()
	const reopened = await getPackageCodemodRunById(env.APP_DB, 'run-heartbeat')
	expect(reopened).toMatchObject({ status: 'running' })
	expect(reopened!.updatedAt > '2026-07-30T10:00:00.000Z').toBe(true)
})

test('package codemod step rejects a cursor without a runId', async () => {
	resetMocks()
	const { env } = createEnv()
	mocks.listSavedPackagesByUserId.mockResolvedValue([])

	await expect(
		runPackageCodemodStep({
			env,
			baseUrl: 'https://example.com',
			initiatedByUserId: 'user-1',
			codemodId,
			mode: 'scan',
			scope: { kind: 'user', userId: 'user-1' },
			cursor: 'pkg-somewhere',
			limit: 50,
		}),
	).rejects.toThrow('cursor requires runId')
})
