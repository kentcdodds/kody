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
	getSavedPackageByName: vi.fn(),
	getPlatformAccountByUsername: vi.fn(),
	isPlatformAccountStableUserId: vi.fn(),
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
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/scope-grants.ts', () => ({
	getPlatformAccountByUsername: (...args: Array<unknown>) =>
		mockModule.getPlatformAccountByUsername(...args),
	isPlatformAccountStableUserId: (...args: Array<unknown>) =>
		mockModule.isPlatformAccountStableUserId(...args),
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
	['saved package by name (D1)', mockModule.getSavedPackageByName],
	[
		'platform account by username (D1)',
		mockModule.getPlatformAccountByUsername,
	],
	[
		'platform account by user id (D1)',
		mockModule.isPlatformAccountStableUserId,
	],
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
	packageName?: string
	kodyId?: string
}) {
	const suffix = input.suffix ?? input.userId
	const sourceId = `source-${suffix}`
	const savedPackage = {
		id: `pkg-${suffix}`,
		userId: input.userId,
		name: input.packageName ?? '@kentcdodds/sentry-triage',
		kodyId: input.kodyId ?? 'sentry-triage',
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
		name: savedPackage.name,
		exports: {
			'./get-issue-state': './src/get-issue-state.ts',
		},
		kody: {
			id: savedPackage.kodyId,
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
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { userId: string; name: string }) => {
			const fixture = fixturesByUserId[input.userId]
			return fixture?.savedPackage.name === input.name
				? fixture.savedPackage
				: null
		},
	)
	mockModule.getPlatformAccountByUsername.mockImplementation(
		async (_db: unknown, username: string) =>
			username === 'kody'
				? {
						id: 1,
						username: 'kody',
						email: 'kody@example.com',
						stableUserId: 'platform-owner',
					}
				: null,
	)
	mockModule.isPlatformAccountStableUserId.mockImplementation(
		async (_db: unknown, stableUserId: string) =>
			stableUserId === 'platform-owner',
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
			return {
				row: {
					kvKey: 'kv-key',
					publishedCommit: fixture.artifact.publishedCommit,
				},
				artifact: fixture.artifact,
			}
		},
	)
}

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
	} as Env
}

async function runContractCheck(input: { userId: string; specifier?: string }) {
	return await checkPackageInvokeForRuntimeWithPreloads({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: input.userId,
		rawInput: {
			specifier:
				input.specifier ?? 'kody:@kentcdodds/sentry-triage/get-issue-state',
			options: { params: { issueId: 'issue-1' } },
		},
	})
}

test('person package runtimes cannot invoke official platform packages', async () => {
	seedFixtures({
		'user-1': createFixture({ userId: 'user-1', publishedCommit: 'commit-1' }),
		'platform-owner': createFixture({
			userId: 'platform-owner',
			publishedCommit: 'commit-1',
			packageName: '@kody/github',
			kodyId: 'github',
		}),
	})
	mockModule.getSavedPackageById.mockImplementation(
		async (_db: unknown, input: { userId: string; packageId: string }) =>
			input.userId === 'user-1' && input.packageId === 'pkg-user-1'
				? {
						id: 'pkg-user-1',
						userId: 'user-1',
						name: '@kentcdodds/sentry-triage',
						kodyId: 'sentry-triage',
					}
				: null,
	)

	const denied = await checkPackageInvokeForRuntimeWithPreloads({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: 'user-1',
		rawInput: {
			specifier: 'kody:@kody/github/get-issue-state',
			options: { params: {} },
		},
		callerKind: 'package',
		callingPackageId: 'pkg-user-1',
	})
	expect(denied.result.ok).toBe(false)
	expect(denied.result.message).toContain('not runnable from a person account')
	expect(denied.preloads).toBeNull()

	const fromExecute = await checkPackageInvokeForRuntimeWithPreloads({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: 'user-1',
		rawInput: {
			specifier: 'kody:@kody/github/get-issue-state',
			options: { params: {} },
		},
		callerKind: 'execute',
	})
	expect(fromExecute.result.ok).toBe(false)
	expect(fromExecute.result.message).toContain(
		'not runnable from a person account',
	)
	expect(fromExecute.preloads).toBeNull()

	mockModule.getSavedPackageById.mockImplementation(
		async (_db: unknown, input: { userId: string; packageId: string }) =>
			input.userId === 'platform-owner' && input.packageId === 'pkg-kody-github'
				? {
						id: 'pkg-kody-github',
						userId: 'platform-owner',
						name: '@kody/github',
						kodyId: 'github',
					}
				: null,
	)
	const fromPlatformPackage = await checkPackageInvokeForRuntimeWithPreloads({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: 'platform-owner',
		rawInput: {
			specifier: 'kody:@kody/github/get-issue-state',
			options: { params: {} },
		},
		callerKind: 'package',
		callingPackageId: 'pkg-kody-github',
	})
	expect(fromPlatformPackage.result.ok).toBe(true)
})

test('a warm keyless invoke contract check performs zero D1/KV loads', async () => {
	seedFixtures({
		'user-1': createFixture({ userId: 'user-1', publishedCommit: 'commit-1' }),
	})

	const cold = await runContractCheck({ userId: 'user-1' })
	expect(cold.result.ok).toBe(true)
	expect(cold.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
		'commit-1',
	)
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledTimes(1)
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
		'saved package by name (D1)': 0,
		'platform account by username (D1)': 0,
		'platform account by user id (D1)': 0,
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
		packageIdOrKodyIds: [
			fixture.savedPackage.id,
			fixture.savedPackage.kodyId,
			`kody:${fixture.savedPackage.name}`,
		],
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
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledTimes(1)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
})

test('platform package invalidation clears the platform-owner specifier cache', async () => {
	const platformFixture = createFixture({
		userId: 'platform-owner',
		publishedCommit: 'commit-platform',
		packageName: '@kody/sentry-triage',
	})
	seedFixtures({ 'platform-owner': platformFixture })

	const beforeDelete = await runContractCheck({
		userId: 'platform-owner',
		specifier: 'kody:@kody/sentry-triage/get-issue-state',
	})
	expect(beforeDelete.result.ok).toBe(true)
	expect(beforeDelete.preloads?.savedPackage.id).toBe(
		platformFixture.savedPackage.id,
	)

	clearContractCheckLoadCounters()
	const warm = await runContractCheck({
		userId: 'platform-owner',
		specifier: 'kody:@kody/sentry-triage/get-issue-state',
	})
	expect(warm.result.ok).toBe(true)
	expect(countContractCheckLoads()).toEqual({
		'saved package by id (D1)': 0,
		'saved package by kody id (D1)': 0,
		'saved package by name (D1)': 0,
		'platform account by username (D1)': 0,
		'platform account by user id (D1)': 0,
		'entity source row (D1)': 0,
		'published manifest snapshot (KV)': 0,
		'published source snapshot (KV)': 0,
		'bundle artifact identity + payload (D1 + KV)': 0,
	})

	seedFixtures({})
	invalidateInvokeContractFreshness({
		userId: 'platform-owner',
		packageIdOrKodyIds: [
			platformFixture.savedPackage.id,
			platformFixture.savedPackage.kodyId,
			`kody:${platformFixture.savedPackage.name}`,
		],
		sourceId: platformFixture.source.id,
	})

	const afterDelete = await runContractCheck({
		userId: 'platform-owner',
		specifier: 'kody:@kody/sentry-triage/get-issue-state',
	})
	expect(afterDelete.result.ok).toBe(false)
	expect(afterDelete.result.message).toContain('could not be resolved')
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

test('ensureModuleArtifact rebuilds when the identity artifact is for a different commit', async () => {
	const fixture = createFixture({
		userId: 'user-stale-artifact',
		publishedCommit: 'commit-new',
		suffix: 'stale-artifact',
	})
	mockModule.getEntitySourceById.mockResolvedValue(fixture.source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: fixture.manifestContent,
	})
	mockModule.loadPublishedEntitySource.mockResolvedValue({
		source: fixture.source,
		files: {
			'package.json': fixture.manifestContent,
			'src/get-issue-state.ts':
				'export default async function main() { return "new" }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity
		.mockResolvedValueOnce({
			row: { publishedCommit: 'commit-old' },
			artifact: { ...fixture.artifact, publishedCommit: 'commit-old' },
		})
		.mockResolvedValueOnce({
			row: { publishedCommit: 'commit-new' },
			artifact: fixture.artifact,
		})
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

	const rebuilt = await ensureModuleArtifact({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		savedPackage: fixture.savedPackage,
		selector: { kind: 'export', exportName: 'get-issue-state' },
		userId: fixture.savedPackage.userId,
	})

	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledTimes(1)
	expect(rebuilt.artifact.publishedCommit).toBe('commit-new')
})

test('ensureModuleArtifact rebuilds when the identity row is missing a published commit', async () => {
	const fixture = createFixture({
		userId: 'user-null-row',
		publishedCommit: 'commit-new',
		suffix: 'null-row',
	})
	mockModule.getEntitySourceById.mockResolvedValue(fixture.source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: fixture.manifestContent,
	})
	mockModule.loadPublishedEntitySource.mockResolvedValue({
		source: fixture.source,
		files: {
			'package.json': fixture.manifestContent,
			'src/get-issue-state.ts':
				'export default async function main() { return "new" }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity
		.mockResolvedValueOnce({
			row: { publishedCommit: null },
			artifact: fixture.artifact,
		})
		.mockResolvedValueOnce({
			row: { publishedCommit: 'commit-new' },
			artifact: fixture.artifact,
		})
	mockModule.typecheckPackageEntrypointsFromSourceFiles.mockResolvedValue({
		ok: true,
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'main.js',
		modules: { 'main.js': 'export default async () => ({ ok: true })' },
		dependencies: [],
		dynamicDependencies: [],
	})
	mockModule.persistPublishedBundleArtifact.mockReset()
	mockModule.persistPublishedBundleArtifact.mockResolvedValue('kv-key')

	const rebuilt = await ensureModuleArtifact({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		savedPackage: fixture.savedPackage,
		selector: { kind: 'export', exportName: 'get-issue-state' },
		userId: fixture.savedPackage.userId,
	})

	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledTimes(1)
	expect(rebuilt.artifact.publishedCommit).toBe('commit-new')
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
