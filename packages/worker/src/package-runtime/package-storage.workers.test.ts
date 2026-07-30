import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getExecutionErrorDetails } from '#mcp/executor.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import {
	buildPackageStorageId,
	createPackageStorageAccessDeniedMessage,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'

/**
 * End-to-end behavior matrix for `packageStorage()` against REAL
 * `buildKodyModuleBundle` / `buildKodyImportableModuleBundle` output —
 * synthetic module maps previously masked bundler inlining (see #814), so
 * every scenario here runs the module graph the way production does:
 * publish an importable artifact, statically import it, and execute the
 * merged bundle through `runBundledModuleWithRegistry`.
 */

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSavedPackageArtifactSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
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
	try {
		await runSql(
			`ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1`,
		)
	} catch {
		// Column already present on newer schemas.
	}
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

async function insertSavedPackage(input: {
	userId: string
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		input.packageId,
		input.userId,
		input.name,
		input.kodyId,
		`${input.name} package`,
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
		created_at: now,
		updated_at: now,
	}
}

/**
 * Publishes one saved package end-to-end the way the registry does: source
 * snapshot plus one importable-module artifact per export, each artifact
 * bundled with `rootPackageId` so its modules carry the package-runtime
 * stamp.
 */
async function publishPackage(input: {
	userId: string
	name: string
	kodyId: string
	sourceFiles: Record<string, string>
	exports: Array<{ artifactName: string; entryPoint: string }>
}) {
	const unique = crypto.randomUUID()
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const source = await insertSavedPackage({
		userId: input.userId,
		packageId,
		kodyId: input.kodyId,
		name: input.name,
		sourceId,
		publishedCommit: `commit-${unique}`,
	})
	await persistPublishedSourceSnapshot({
		env,
		userId: input.userId,
		source,
		snapshot: { files: input.sourceFiles },
	})
	for (const target of input.exports) {
		const artifactBundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: input.userId,
			sourceFiles: input.sourceFiles,
			entryPoint: target.entryPoint,
			rootPackageId: packageId,
		})
		await persistPublishedBundleArtifact({
			env,
			userId: input.userId,
			source,
			kind: 'importable-module',
			artifactName: target.artifactName,
			entryPoint: target.entryPoint,
			mainModule: artifactBundle.mainModule,
			modules: artifactBundle.modules,
			dependencies: artifactBundle.dependencies,
			packageContext: {
				packageId,
				kodyId: input.kodyId,
				sourceId,
			},
		})
	}
	return { packageId, sourceId }
}

function createCallerContext(userId: string) {
	return createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId,
			email: 'worker@example.com',
			displayName: 'Worker Test',
		},
	})
}

function packageBucketRunner(userId: string, packageId: string) {
	return storageRunnerRpc({
		env,
		userId,
		storageId: buildPackageStorageId(packageId),
	})
}

test(
	'statically imported package code reads its own bucket from an ad hoc execute call',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const userId = `user-${crypto.randomUUID()}`
		const { packageId } = await publishPackage({
			userId,
			name: '@kentcdodds/notes',
			kodyId: 'notes',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/notes',
					exports: { './note-list': './src/note-list.ts' },
					kody: { id: 'notes', description: 'Note storage' },
				}),
				'src/note-list.ts': [
					"import { packageStorage, storage } from 'kody:runtime'",
					'export default async function noteList() {',
					'\tconst bucket = packageStorage()',
					"\tconst result = await bucket.sql('select name from notes order by name asc')",
					'\treturn {',
					'\t\tambientStorageType: typeof storage,',
					'\t\tbucketId: bucket.id,',
					'\t\tnames: result.rows.map((row) => row.name),',
					'\t}',
					'}',
				].join('\n'),
			},
			exports: [
				{ artifactName: './note-list', entryPoint: 'src/note-list.ts' },
			],
		})
		// Seed the package's own bucket for `packageStorage()` (package
		// invocations leave ambient storage unbound).
		const runner = packageBucketRunner(userId, packageId)
		await runner.sqlQuery({
			query: 'create table if not exists notes (name text primary key)',
			writable: true,
		})
		await runner.sqlQuery({
			query: "insert into notes (name) values ('debugging'), ('writing')",
			writable: true,
		})

		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import noteList from 'kody:@kentcdodds/notes/note-list'",
					'export default async function main() {',
					'\treturn await noteList()',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		// The bundle records the dependency's immutable package id — that is
		// the provenance the host grants `packageStorage()` access from.
		expect(bundle.dependencies).toMatchObject([{ packageId }])

		const result = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			// Ad hoc execute without a bound storageId: ambient storage stays
			// undefined even though packageStorage() works.
			ambientStorageType: 'undefined',
			bucketId: buildPackageStorageId(packageId),
			names: ['debugging', 'writing'],
		})
	},
)

test(
	'two statically imported packages each write and read their own bucket',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const userId = `user-${crypto.randomUUID()}`
		const publishOwnerPackage = async (leaf: 'alpha' | 'beta') =>
			await publishPackage({
				userId,
				name: `@kentcdodds/${leaf}`,
				kodyId: leaf,
				sourceFiles: {
					'package.json': JSON.stringify({
						name: `@kentcdodds/${leaf}`,
						exports: { './whoami': './src/whoami.ts' },
						kody: { id: leaf, description: `${leaf} storage owner` },
					}),
					'src/whoami.ts': [
						"import { packageStorage } from 'kody:runtime'",
						'export default async function whoami() {',
						'\tconst bucket = packageStorage()',
						`\tawait bucket.set('written-by', ${JSON.stringify(leaf)})`,
						"\treturn { bucketId: bucket.id, owner: await bucket.get('owner') }",
						'}',
					].join('\n'),
				},
				exports: [{ artifactName: './whoami', entryPoint: 'src/whoami.ts' }],
			})
		const alpha = await publishOwnerPackage('alpha')
		const beta = await publishOwnerPackage('beta')
		await packageBucketRunner(userId, alpha.packageId).setValue({
			key: 'owner',
			value: 'alpha-bucket',
		})
		await packageBucketRunner(userId, beta.packageId).setValue({
			key: 'owner',
			value: 'beta-bucket',
		})

		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import alphaWhoami from 'kody:@kentcdodds/alpha/whoami'",
					"import betaWhoami from 'kody:@kentcdodds/beta/whoami'",
					'export default async function main() {',
					'\treturn { alpha: await alphaWhoami(), beta: await betaWhoami() }',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			alpha: {
				bucketId: buildPackageStorageId(alpha.packageId),
				owner: 'alpha-bucket',
			},
			beta: {
				bucketId: buildPackageStorageId(beta.packageId),
				owner: 'beta-bucket',
			},
		})
		// The sandbox writes landed in each declaring package's own bucket.
		await expect(
			packageBucketRunner(userId, alpha.packageId).getValue({
				key: 'written-by',
			}),
		).resolves.toEqual({ key: 'written-by', value: 'alpha' })
		await expect(
			packageBucketRunner(userId, beta.packageId).getValue({
				key: 'written-by',
			}),
		).resolves.toEqual({ key: 'written-by', value: 'beta' })
	},
)

test(
	'a package statically imported into another package keeps its own bucket in the host package runtime',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const userId = `user-${crypto.randomUUID()}`
		const inner = await publishPackage({
			userId,
			name: '@kentcdodds/inner',
			kodyId: 'inner',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/inner',
					exports: { './whoami': './src/whoami.ts' },
					kody: { id: 'inner', description: 'Inner storage owner' },
				}),
				'src/whoami.ts': [
					"import { packageStorage } from 'kody:runtime'",
					'export default async function whoami() {',
					"\treturn { bucketId: packageStorage().id, owner: await packageStorage().get('owner') }",
					'}',
				].join('\n'),
			},
			exports: [{ artifactName: './whoami', entryPoint: 'src/whoami.ts' }],
		})
		await packageBucketRunner(userId, inner.packageId).setValue({
			key: 'owner',
			value: 'inner-bucket',
		})

		const outerUnique = crypto.randomUUID()
		const outerPackageId = `pkg-${outerUnique}`
		const outerSourceFiles = {
			'package.json': JSON.stringify({
				name: '@kentcdodds/outer',
				exports: { './run': './src/run.ts' },
				kody: {
					id: 'outer',
					description: 'Outer package importing inner',
					dependencies: ['@kentcdodds/inner'],
				},
			}),
			'src/run.ts': [
				"import { packageStorage, storage } from 'kody:runtime'",
				"import innerWhoami from 'kody:@kentcdodds/inner/whoami'",
				'export default async function run() {',
				'\treturn {',
				'\t\tinner: await innerWhoami(),',
				'\t\touterBucketId: packageStorage().id,',
				'\t\tambientStorageType: typeof storage,',
				'\t}',
				'}',
			].join('\n'),
		}
		// Build the outer package's own module bundle the way package
		// invocations do (rootPackageId stamps the outer sources).
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: outerSourceFiles,
			entryPoint: 'src/run.ts',
			rootPackageId: outerPackageId,
		})
		// Package invocation runs bind no ambient storage (no storageTools):
		// the package bucket is reachable only through packageStorage().
		const result = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				packageContext: {
					packageId: outerPackageId,
					kodyId: 'outer',
					sourceId: `source-${outerUnique}`,
				},
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			inner: {
				bucketId: buildPackageStorageId(inner.packageId),
				owner: 'inner-bucket',
			},
			outerBucketId: buildPackageStorageId(outerPackageId),
			// Ambient storage is absent in package-invocation runs; guarded
			// access observes undefined.
			ambientStorageType: 'undefined',
		})
	},
)

test(
	'a package invocation run that dereferences ambient storage gets the packageStorage() unbound hint',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const userId = `user-${crypto.randomUUID()}`
		const unique = crypto.randomUUID()
		const packageId = `pkg-${unique}`
		// Legacy package code (published before the #820 check) that uses the
		// ambient storage helper guard-lessly: with the invocation-context
		// binding removed, the bare TypeError is rewritten to the structured
		// runtime_helper_unbound hint whose remedy leads with packageStorage().
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/legacy',
					exports: { './main': './src/main.ts' },
					kody: { id: 'legacy', description: 'Legacy ambient storage' },
				}),
				'src/main.ts': [
					"import { storage } from 'kody:runtime'",
					'export default async function main() {',
					"\treturn await storage.get('key')",
					'}',
				].join('\n'),
			},
			entryPoint: 'src/main.ts',
			rootPackageId: packageId,
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				packageContext: {
					packageId,
					kodyId: 'legacy',
					sourceId: `source-${unique}`,
				},
			},
		)
		expect(result.error).toBeDefined()
		const details = getExecutionErrorDetails(result.error)
		expect(details).toMatchObject({
			kind: 'runtime_helper_unbound',
			helperName: 'storage',
		})
		expect(details?.nextStep).toContain('packageStorage()')
		expect(details?.nextStep?.indexOf('packageStorage()')).toBeLessThan(
			details?.nextStep?.indexOf('storageId') ?? -1,
		)
	},
)

test(
	'inline execute code without package provenance gets an actionable packageStorage error',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = `user-${crypto.randomUUID()}`
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import { packageStorage } from 'kody:runtime'",
					'export default async function main() {',
					"\treturn await packageStorage().get('anything')",
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toContain(
			'packageStorage() requires package provenance',
		)
		expect(result.error).toContain(
			'keyless packages.invoke({ kodyId, exportName, params })',
		)
		expect(result.error).not.toContain('packages.invokeChecked')
	},
)

test(
	'hand-written package ids are rejected: only bundler-recorded provenance grants bucket access',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const userId = `user-${crypto.randomUUID()}`
		// The victim package exists and has data, but the execute code below
		// never statically imports it — so its id is not in the grant set.
		const victim = await publishPackage({
			userId,
			name: '@kentcdodds/victim',
			kodyId: 'victim',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/victim',
					exports: { './noop': './src/noop.ts' },
					kody: { id: 'victim', description: 'Holds private data' },
				}),
				'src/noop.ts': 'export default async function noop() { return null }',
			},
			exports: [{ artifactName: './noop', entryPoint: 'src/noop.ts' }],
		})
		await packageBucketRunner(userId, victim.packageId).setValue({
			key: 'secret',
			value: 'do-not-leak',
		})

		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import { kody } from 'kody:runtime'",
					'export default async function main() {',
					// A forged host-tool call with a hand-written package id —
					// exactly what a malicious module would try.
					`\treturn await kody.package_storage_get({ packageId: ${JSON.stringify(
						victim.packageId,
					)}, key: 'secret' })`,
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toContain(
			createPackageStorageAccessDeniedMessage(victim.packageId),
		)
		expect(result.error).not.toContain('do-not-leak')
	},
)
