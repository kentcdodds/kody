import { expect, test, vi } from 'vitest'
import { checkPackageInvokeForRuntimeWithPreloads } from './invoke-check.ts'
import {
	invalidateInvokeContractFreshness,
	invokeContractFreshnessTtlMs,
	loadModuleArtifactWithCommitCache,
} from './invoke-contract-cache.ts'
import {
	ensureModuleArtifact,
	loadInvokeManifestBySourceId,
} from './module-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	loadPublishedEntitySource: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	typecheckPackageEntrypointsFromSourceFiles: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
	loadPublishedEntitySource: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntitySource(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		mockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		mockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#worker/repo/checks.ts', () => ({
	typecheckPackageEntrypointsFromSourceFiles: (...args: Array<unknown>) =>
		mockModule.typecheckPackageEntrypointsFromSourceFiles(...args),
}))

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

/**
 * Every mock above stands in for exactly one awaited D1 or KV load the
 * contract check would otherwise perform per call. The warm-path tests assert
 * all of them stay at zero.
 */
const contractCheckLoadMocks = [
	['saved package by id (D1)', mockModule.getSavedPackageById],
	['saved package by kody id (D1)', mockModule.getSavedPackageByKodyId],
	['entity source row (D1)', mockModule.getEntitySourceById],
	['published manifest snapshot (KV)', mockModule.loadPublishedEntityManifest],
	['published source snapshot (KV)', mockModule.loadPublishedEntitySource],
	[
		'bundle artifact identity + payload (D1 + KV)',
		mockModule.loadPublishedBundleArtifactByIdentity,
	],
] as const

function countContractCheckLoads() {
	return Object.fromEntries(
		contractCheckLoadMocks.map(([label, mock]) => [
			label,
			mock.mock.calls.length,
		]),
	)
}

function clearContractCheckLoadCounters() {
	for (const [, mock] of contractCheckLoadMocks) {
		mock.mockClear()
	}
}

function createFixture(input: {
	userId: string
	publishedCommit: string
	suffix?: string
}) {
	const suffix = input.suffix ?? input.userId
	const sourceId = `source-${suffix}`
	const savedPackage = {
		id: `pkg-${suffix}`,
		userId: input.userId,
		name: '@kentcdodds/sentry-triage',
		kodyId: 'sentry-triage',
		description: 'Sentry triage helpers',
		tags: [],
		searchText: null,
		sourceId,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	}
	const source = {
		id: sourceId,
		user_id: input.userId,
		entity_kind: 'package' as const,
		entity_id: savedPackage.id,
		repo_id: `repo-${suffix}`,
		published_commit: input.publishedCommit,
		indexed_commit: input.publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-07-01T00:00:00.000Z',
		updated_at: '2026-07-01T00:00:00.000Z',
	}
	const manifestContent = JSON.stringify({
		name: '@kentcdodds/sentry-triage',
		exports: {
			'./get-issue-state': './src/get-issue-state.ts',
		},
		kody: {
			id: 'sentry-triage',
			description: 'Sentry triage helpers',
		},
	})
	const artifact = {
		version: 1,
		kind: 'module' as const,
		artifactName: './get-issue-state',
		sourceId,
		publishedCommit: input.publishedCommit,
		entryPoint: 'src/get-issue-state.ts',
		mainModule: 'main.js',
		modules: { 'main.js': 'export default async () => ({ ok: true })' },
		dependencies: [],
		dynamicDependencies: [],
		packageContext: {
			packageId: savedPackage.id,
			kodyId: savedPackage.kodyId,
			sourceId,
		},
		serviceContext: null,
		createdAt: '2026-07-01T00:00:00.000Z',
	}
	return { savedPackage, source, manifestContent, artifact }
}

type Fixture = ReturnType<typeof createFixture>

function seedFixtures(fixturesByUserId: Record<string, Fixture>) {
	const byKodyId = (userId: string, kodyId: string) => {
		const fixture = fixturesByUserId[userId]
		return fixture && fixture.savedPackage.kodyId === kodyId
			? fixture.savedPackage
			: null
	}
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.getSavedPackageByKodyId.mockImplementation(
		async (_db: unknown, input: { userId: string; kodyId: string }) =>
			byKodyId(input.userId, input.kodyId),
	)
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			Object.values(fixturesByUserId).find(
				(fixture) => fixture.source.id === sourceId,
			)?.source ?? null,
	)
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { sourceId: string }) => {
			const fixture = Object.values(fixturesByUserId).find(
				(candidate) => candidate.source.id === input.sourceId,
			)
			if (!fixture) throw new Error(`No manifest for ${input.sourceId}`)
			return { source: fixture.source, content: fixture.manifestContent }
		},
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { sourceId: string }) => {
			const fixture = Object.values(fixturesByUserId).find(
				(candidate) => candidate.source.id === input.sourceId,
			)
			if (!fixture) return null
			return { row: { kvKey: 'kv-key' }, artifact: fixture.artifact }
		},
	)
}

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
	} as Env
}

async function runContractCheck(input: { userId: string }) {
	return await checkPackageInvokeForRuntimeWithPreloads({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: input.userId,
		rawInput: {
			kodyId: 'sentry-triage',
			exportName: 'get-issue-state',
			params: { issueId: 'issue-1' },
		},
		includeExportProjection: false,
	})
}

test('a warm keyless invoke contract check performs zero D1/KV loads', async () => {
	seedFixtures({
		'user-1': createFixture({ userId: 'user-1', publishedCommit: 'commit-1' }),
	})

	const cold = await runContractCheck({ userId: 'user-1' })
	expect(cold.result.ok).toBe(true)
	expect(cold.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
		'commit-1',
	)
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledTimes(1)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)

	clearContractCheckLoadCounters()
	const warm = await runContractCheck({ userId: 'user-1' })

	expect(warm.result.ok).toBe(true)
	expect(warm.result.ok && warm.result.contract.publishedCommit).toBe(
		'commit-1',
	)
	expect(warm.preloads?.savedPackage.id).toBe('pkg-user-1')
	expect(warm.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
		'commit-1',
	)
	expect(countContractCheckLoads()).toEqual({
		'saved package by id (D1)': 0,
		'saved package by kody id (D1)': 0,
		'entity source row (D1)': 0,
		'published manifest snapshot (KV)': 0,
		'published source snapshot (KV)': 0,
		'bundle artifact identity + payload (D1 + KV)': 0,
	})
})

test('a republish is picked up immediately after same-isolate invalidation', async () => {
	const fixture = createFixture({
		userId: 'user-1',
		publishedCommit: 'commit-1',
	})
	seedFixtures({ 'user-1': fixture })

	const beforeRepublish = await runContractCheck({ userId: 'user-1' })
	expect(
		beforeRepublish.result.ok &&
			beforeRepublish.result.contract.publishedCommit,
	).toBe('commit-1')

	// Republish: the source row advances to commit-2 and new artifacts exist.
	seedFixtures({
		'user-1': createFixture({ userId: 'user-1', publishedCommit: 'commit-2' }),
	})

	// Still within the freshness TTL, the warm cache serves the old contract.
	const stillCached = await runContractCheck({ userId: 'user-1' })
	expect(
		stillCached.result.ok && stillCached.result.contract.publishedCommit,
	).toBe('commit-1')

	// The projection refresh invalidates in its own isolate.
	invalidateInvokeContractFreshness({
		userId: 'user-1',
		packageIdOrKodyIds: [fixture.savedPackage.id, fixture.savedPackage.kodyId],
		sourceId: fixture.source.id,
	})
	const afterInvalidation = await runContractCheck({ userId: 'user-1' })
	expect(
		afterInvalidation.result.ok &&
			afterInvalidation.result.contract.publishedCommit,
	).toBe('commit-2')
	expect(
		afterInvalidation.preloads?.moduleArtifact.artifact.publishedCommit,
	).toBe('commit-2')
})

test('a republish is picked up in other isolates once the freshness TTL elapses', async () => {
	vi.useFakeTimers()
	try {
		seedFixtures({
			'user-1': createFixture({
				userId: 'user-1',
				publishedCommit: 'commit-1',
			}),
		})
		const warm = await runContractCheck({ userId: 'user-1' })
		expect(warm.result.ok && warm.result.contract.publishedCommit).toBe(
			'commit-1',
		)

		// Republish observed only through D1/KV — no invalidation reaches this
		// isolate.
		seedFixtures({
			'user-1': createFixture({
				userId: 'user-1',
				publishedCommit: 'commit-2',
			}),
		})
		vi.setSystemTime(Date.now() + invokeContractFreshnessTtlMs + 1)

		const afterTtl = await runContractCheck({ userId: 'user-1' })
		expect(afterTtl.result.ok && afterTtl.result.contract.publishedCommit).toBe(
			'commit-2',
		)
		expect(afterTtl.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
			'commit-2',
		)
	} finally {
		vi.useRealTimers()
	}
})

test('contract-check caches never serve entries across users', async () => {
	seedFixtures({
		'user-1': createFixture({ userId: 'user-1', publishedCommit: 'commit-1' }),
		'user-2': createFixture({
			userId: 'user-2',
			publishedCommit: 'commit-2',
			suffix: 'user-2',
		}),
	})

	const first = await runContractCheck({ userId: 'user-1' })
	expect(first.result.ok && first.result.contract.publishedCommit).toBe(
		'commit-1',
	)

	clearContractCheckLoadCounters()
	const other = await runContractCheck({ userId: 'user-2' })

	expect(other.result.ok && other.result.contract.publishedCommit).toBe(
		'commit-2',
	)
	expect(other.preloads?.savedPackage.id).toBe('pkg-user-2')
	// The second user's check must load its own rows, not reuse user-1's.
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledTimes(1)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
})

test('an artifact rebuild resolves its entry point from the fresh source, not the cached manifest', async () => {
	const userId = 'user-rebuild'
	const sourceId = 'source-rebuild'
	const savedPackage = createFixture({
		userId,
		publishedCommit: 'commit-1',
		suffix: 'rebuild',
	}).savedPackage
	const buildManifestContent = (entryPoint: string) =>
		JSON.stringify({
			name: '@kentcdodds/sentry-triage',
			exports: { './probe': entryPoint },
			kody: { id: 'sentry-triage', description: 'probe' },
		})
	const buildSourceRow = (publishedCommit: string) => ({
		...createFixture({ userId, publishedCommit, suffix: 'rebuild' }).source,
		id: sourceId,
	})

	// Warm the freshness cache with the commit-1 row + manifest, where the
	// probe export points at the v1 entry point.
	mockModule.getEntitySourceById.mockResolvedValue(buildSourceRow('commit-1'))
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: buildSourceRow('commit-1'),
		content: buildManifestContent('./src/probe-v1.ts'),
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.typecheckPackageEntrypointsFromSourceFiles.mockResolvedValue({
		ok: true,
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'main.js',
		modules: { 'main.js': 'export default async () => ({ ok: true })' },
		dependencies: [],
		dynamicDependencies: [],
	})
	mockModule.persistPublishedBundleArtifact.mockResolvedValue('kv-key')

	// Republish lands between the manifest load and the rebuild: the fresh
	// source is commit-2 and moves the probe export to the v2 entry point,
	// while this isolate's freshness cache still holds the commit-1 row.
	const v2Files = {
		'package.json': buildManifestContent('./src/probe-v2.ts'),
		'src/probe-v2.ts': 'export default async function probe() { return 2 }',
	}
	const runEnsure = async () =>
		await ensureModuleArtifact({
			env: createEnv(),
			baseUrl: 'https://kody.dev',
			savedPackage: { ...savedPackage, sourceId },
			selector: { kind: 'export', exportName: 'probe' },
			userId,
		})

	// Warm only the freshness-tier row cache with the commit-1 manifest (no
	// artifact exists for the identity yet).
	await loadInvokeManifestBySourceId({
		env: createEnv(),
		userId,
		sourceId,
	})

	// Now the republish is visible to fresh reads only; the first-ever
	// artifact rebuild for this identity happens against the stale cached
	// manifest.
	mockModule.getEntitySourceById.mockResolvedValue(buildSourceRow('commit-2'))
	mockModule.loadPublishedEntitySource.mockResolvedValue({
		source: buildSourceRow('commit-2'),
		files: v2Files,
	})
	mockModule.loadPublishedBundleArtifactByIdentity
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce({
			row: { kvKey: 'kv-key' },
			artifact: { publishedCommit: 'commit-2', entryPoint: 'src/probe-v2.ts' },
		})

	const rebuilt = await runEnsure()

	// The rebuild must be self-consistent with the freshly loaded commit-2
	// source: typecheck, bundle, and persisted identity all use the v2 entry
	// point, even though this isolate's cached manifest still says v1.
	expect(
		mockModule.typecheckPackageEntrypointsFromSourceFiles,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoints: [{ path: 'src/probe-v2.ts', includeStorage: true }],
		}),
	)
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/probe-v2.ts' }),
	)
	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/probe-v2.ts' }),
	)
	expect(rebuilt.artifact.publishedCommit).toBe('commit-2')
	expect(rebuilt.entryPoint).toBe('src/probe-v2.ts')
})

test('an artifact from a different commit is served but never retained', async () => {
	const load = vi.fn(async () => ({
		artifact: { publishedCommit: 'commit-old' } as never,
		source: { id: 'source-mismatch' } as never,
		entryPoint: 'src/index.ts',
	}))

	const first = await loadModuleArtifactWithCommitCache({
		userId: 'user-1',
		sourceId: 'source-mismatch',
		publishedCommit: 'commit-new',
		artifactName: './index',
		entryPoint: 'src/index.ts',
		load,
	})
	const second = await loadModuleArtifactWithCommitCache({
		userId: 'user-1',
		sourceId: 'source-mismatch',
		publishedCommit: 'commit-new',
		artifactName: './index',
		entryPoint: 'src/index.ts',
		load,
	})

	expect(first.artifact.publishedCommit).toBe('commit-old')
	expect(second.artifact.publishedCommit).toBe('commit-old')
	// A commit mismatch means the entry must not be cached under this key.
	expect(load).toHaveBeenCalledTimes(2)
})
