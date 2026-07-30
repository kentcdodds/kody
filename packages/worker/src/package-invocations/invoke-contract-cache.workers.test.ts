import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { checkPackageInvokeForRuntimeWithPreloads } from './invoke-check.ts'
import { invalidateInvokeContractFreshness } from './invoke-contract-cache.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSavedPackageArtifactSchema() {
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
		indexed_commit TEXT,
		manifest_path TEXT NOT NULL DEFAULT 'package.json',
		source_root TEXT NOT NULL DEFAULT '/',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		published_commit TEXT NOT NULL,
		artifact_kind TEXT NOT NULL,
		artifact_name TEXT,
		entry_point TEXT NOT NULL,
		kv_key TEXT NOT NULL,
		dependencies_json TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
}

function createSourceRow(input: {
	userId: string
	packageId: string
	sourceId: string
	publishedCommit: string
}) {
	return {
		id: input.sourceId,
		user_id: input.userId,
		entity_kind: 'package' as const,
		entity_id: input.packageId,
		repo_id: `repo-${input.sourceId}`,
		published_commit: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-07-30T00:00:00.000Z',
		updated_at: '2026-07-30T00:00:00.000Z',
	}
}

function createProbeSourceFiles(input: { kodyId: string; version: string }) {
	return {
		'package.json': JSON.stringify({
			name: `@kentcdodds/${input.kodyId}`,
			exports: {
				'./probe': './src/probe.ts',
			},
			kody: {
				id: input.kodyId,
				description: 'Invoke contract cache probe target',
			},
		}),
		'src/probe.ts': [
			'export default async function probe() {',
			`\treturn { version: 'republish-${input.version}-marker' }`,
			'}',
		].join('\n'),
	}
}

async function seedPublishedProbePackage(input: {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string
	version: string
	insertRows: boolean
}) {
	const now = new Date().toISOString()
	if (input.insertRows) {
		await runSql(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
			input.packageId,
			input.userId,
			`@kentcdodds/${input.kodyId}`,
			input.kodyId,
			'Invoke contract cache probe target',
			input.sourceId,
			now,
			now,
		)
		await runSql(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
			input.sourceId,
			input.userId,
			input.packageId,
			`repo-${input.sourceId}`,
			input.publishedCommit,
			now,
			now,
		)
	} else {
		await runSql(
			`UPDATE entity_sources SET published_commit = ?, updated_at = ? WHERE id = ?`,
			input.publishedCommit,
			now,
			input.sourceId,
		)
	}
	const source = createSourceRow(input)
	const sourceFiles = createProbeSourceFiles({
		kodyId: input.kodyId,
		version: input.version,
	})
	await persistPublishedSourceSnapshot({
		env,
		userId: input.userId,
		source,
		snapshot: { files: sourceFiles },
	})
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: input.userId,
		sourceFiles,
		entryPoint: 'src/probe.ts',
	})
	await persistPublishedBundleArtifact({
		env,
		userId: input.userId,
		source,
		kind: 'module',
		artifactName: './probe',
		entryPoint: 'src/probe.ts',
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		packageContext: {
			packageId: input.packageId,
			kodyId: input.kodyId,
			sourceId: input.sourceId,
		},
	})
}

/**
 * Wraps the real D1 and KV bindings so every awaited load the contract check
 * performs is counted at the binding boundary. The contract check only ever
 * reads through `prepare` (D1) and `get` (KV).
 */
function createCountingEnv() {
	const counters = { d1Prepare: 0, kvGet: 0 }
	const countedDb = {
		prepare(...args: Parameters<D1Database['prepare']>) {
			counters.d1Prepare += 1
			return env.APP_DB.prepare(...args)
		},
	} as D1Database
	const realKv = env.BUNDLE_ARTIFACTS_KV as KVNamespace
	const countedKv = {
		get(...args: Parameters<KVNamespace['get']>) {
			counters.kvGet += 1
			return (realKv.get as (...getArgs: Array<unknown>) => unknown)(...args)
		},
		put: (...args: Parameters<KVNamespace['put']>) => realKv.put(...args),
		delete: (...args: Parameters<KVNamespace['delete']>) =>
			realKv.delete(...args),
		list: (...args: Parameters<KVNamespace['list']>) => realKv.list(...args),
	} as unknown as KVNamespace
	const countedEnv = {
		...env,
		APP_DB: countedDb,
		BUNDLE_ARTIFACTS_KV: countedKv,
	} as Env
	const resetCounters = () => {
		counters.d1Prepare = 0
		counters.kvGet = 0
	}
	return { countedEnv, counters, resetCounters }
}

async function runContractCheck(input: {
	countedEnv: Env
	userId: string
	kodyId: string
}) {
	return await checkPackageInvokeForRuntimeWithPreloads({
		env: input.countedEnv,
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: input.userId,
		rawInput: {
			kodyId: input.kodyId,
			exportName: './probe',
			params: {},
		},
		includeExportProjection: false,
	})
}

test(
	'a warm keyless invoke contract check performs zero D1/KV loads against real bindings',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const unique = crypto.randomUUID()
		const userId = `user-${unique}`
		const kodyId = `cache-probe-${unique}`
		await seedPublishedProbePackage({
			userId,
			packageId: `pkg-${unique}`,
			kodyId,
			sourceId: `source-${unique}`,
			publishedCommit: `commit-1-${unique}`,
			version: 'v1',
			insertRows: true,
		})
		const { countedEnv, counters, resetCounters } = createCountingEnv()

		const cold = await runContractCheck({ countedEnv, userId, kodyId })
		expect(cold.result.ok).toBe(true)
		expect(cold.result.ok && cold.result.contract.publishedCommit).toBe(
			`commit-1-${unique}`,
		)
		expect(counters.d1Prepare).toBeGreaterThan(0)
		expect(counters.kvGet).toBeGreaterThan(0)

		resetCounters()
		const warm = await runContractCheck({ countedEnv, userId, kodyId })

		expect(warm.result.ok).toBe(true)
		expect(warm.result.ok && warm.result.contract.publishedCommit).toBe(
			`commit-1-${unique}`,
		)
		expect(warm.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
			`commit-1-${unique}`,
		)
		expect(counters).toEqual({ d1Prepare: 0, kvGet: 0 })
	},
)

test(
	'the cached contract check serves the new commit and artifact after a republish',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const unique = crypto.randomUUID()
		const userId = `user-${unique}`
		const packageId = `pkg-${unique}`
		const kodyId = `republish-probe-${unique}`
		const sourceId = `source-${unique}`
		await seedPublishedProbePackage({
			userId,
			packageId,
			kodyId,
			sourceId,
			publishedCommit: `commit-1-${unique}`,
			version: 'v1',
			insertRows: true,
		})
		const { countedEnv } = createCountingEnv()

		const beforeRepublish = await runContractCheck({
			countedEnv,
			userId,
			kodyId,
		})
		expect(
			beforeRepublish.result.ok &&
				beforeRepublish.result.contract.publishedCommit,
		).toBe(`commit-1-${unique}`)

		await seedPublishedProbePackage({
			userId,
			packageId,
			kodyId,
			sourceId,
			publishedCommit: `commit-2-${unique}`,
			version: 'v2',
			insertRows: false,
		})
		// The projection refresh runs this invalidation in its isolate; other
		// isolates converge within invokeContractFreshnessTtlMs (covered by the
		// node suite with fake timers).
		invalidateInvokeContractFreshness({
			userId,
			packageIdOrKodyIds: [packageId, kodyId],
			sourceId,
		})

		const afterRepublish = await runContractCheck({
			countedEnv,
			userId,
			kodyId,
		})
		expect(
			afterRepublish.result.ok &&
				afterRepublish.result.contract.publishedCommit,
		).toBe(`commit-2-${unique}`)
		const artifact = afterRepublish.preloads?.moduleArtifact.artifact
		expect(artifact?.publishedCommit).toBe(`commit-2-${unique}`)
		// The preloaded artifact is the exact bundle the lean invoke executes;
		// it must carry the republished code, not the cached v1 bundle.
		const moduleSources = Object.values(artifact?.modules ?? {}).join('\n')
		expect(moduleSources).toContain('republish-v2-marker')
		expect(moduleSources).not.toContain('republish-v1-marker')
	},
)
