import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { lockSecretToPackage, saveSecret } from '#mcp/secrets/service.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSecretAuthorityTestSchema() {
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
		locked_at TEXT,
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
	await runSql(`CREATE TABLE IF NOT EXISTS secret_buckets (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		scope TEXT NOT NULL CHECK (scope IN ('session', 'package', 'user')),
		binding_key TEXT NOT NULL,
		expires_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		UNIQUE(user_id, scope, binding_key)
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS secret_entries (
		bucket_id TEXT NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		encrypted_value TEXT NOT NULL,
		allowed_hosts TEXT NOT NULL DEFAULT '[]',
		allowed_packages TEXT NOT NULL DEFAULT '[]',
		lookup_hash TEXT,
		expires_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		PRIMARY KEY (bucket_id, name)
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS community_forks (
		id TEXT PRIMARY KEY NOT NULL,
		listing_id TEXT NOT NULL,
		forker_user_id TEXT NOT NULL,
		origin_commit TEXT NOT NULL,
		forked_package_id TEXT NOT NULL,
		forked_source_id TEXT NOT NULL,
		target_kody_id TEXT NOT NULL,
		listing_name TEXT,
		listing_kody_id TEXT,
		adopted_at TEXT,
		adoption_note TEXT,
		actor TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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

async function markUnadoptedFork(input: {
	userId: string
	packageId: string
	sourceId: string
	kodyId: string
}) {
	await runSql(
		`INSERT INTO community_forks (
			id, listing_id, forker_user_id, origin_commit, forked_package_id,
			forked_source_id, target_kody_id, created_at
		) VALUES (?, ?, ?, 'origin', ?, ?, ?, ?)`,
		`fork-${input.packageId}`,
		`listing-${input.packageId}`,
		input.userId,
		input.packageId,
		input.sourceId,
		input.kodyId,
		new Date().toISOString(),
	)
}

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

test(
	'stamped imports use A-only secret grants; the importing run cannot read them directly',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSecretAuthorityTestSchema()
		const userId = `user-${crypto.randomUUID()}`
		const wake = await publishPackage({
			userId,
			name: '@kentcdodds/grok-bot',
			kodyId: 'grok-bot',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/grok-bot',
					exports: { './wake': './src/wake.ts' },
					kody: {
						id: 'grok-bot',
						description: 'Wake helper',
						secretMounts: {
							wakeToken: { name: 'wakeToken', scope: 'user' },
						},
					},
				}),
				'src/wake.ts': [
					"import { packageSecrets } from 'kody:runtime'",
					'export default async function wake() {',
					'\tconst token = await packageSecrets.get("wakeToken")',
					'\tconst getAuthority = globalThis[Symbol.for("kody.getSecretAuthority")]',
					'\tconst authority =',
					'\t\ttypeof getAuthority === "function" ? getAuthority() : null',
					'\treturn { token, authority }',
					'}',
				].join('\n'),
			},
			exports: [{ artifactName: './wake', entryPoint: 'src/wake.ts' }],
		})
		const importer = await publishPackage({
			userId,
			name: '@kentcdodds/dependent',
			kodyId: 'dependent',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/dependent',
					exports: {
						'./call-wake': './src/call-wake.ts',
						'./steal': './src/steal.ts',
					},
					kody: {
						id: 'dependent',
						description: 'Dependent',
						dependencies: { '@kentcdodds/grok-bot': '*' },
						secretMounts: {
							wakeToken: { name: 'wakeToken', scope: 'user' },
						},
					},
				}),
				'src/call-wake.ts': [
					"import wake from 'kody:@kentcdodds/grok-bot/wake'",
					'export default async function callWake() {',
					'\treturn await wake()',
					'}',
				].join('\n'),
				'src/steal.ts': [
					"import { packageSecrets } from 'kody:runtime'",
					'export default async function steal() {',
					'\ttry {',
					'\t\tconst token = await packageSecrets.get("wakeToken")',
					'\t\treturn { token }',
					'\t} catch (error) {',
					'\t\treturn { error: error instanceof Error ? error.message : String(error) }',
					'\t}',
					'}',
				].join('\n'),
			},
			exports: [
				{ artifactName: './call-wake', entryPoint: 'src/call-wake.ts' },
				{ artifactName: './steal', entryPoint: 'src/steal.ts' },
			],
		})
		await markUnadoptedFork({
			userId,
			packageId: wake.packageId,
			sourceId: wake.sourceId,
			kodyId: 'grok-bot',
		})
		await markUnadoptedFork({
			userId,
			packageId: importer.packageId,
			sourceId: importer.sourceId,
			kodyId: 'dependent',
		})
		await saveSecret({
			env,
			userId,
			scope: 'user',
			name: 'wakeToken',
			value: 'wake-secret-value',
		})
		await lockSecretToPackage({
			env,
			userId,
			name: 'wakeToken',
			packageId: wake.packageId,
		})

		const executeImportBundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import wake from 'kody:@kentcdodds/grok-bot/wake'",
					'export default async function main() {',
					'\treturn await wake()',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const executeImport = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			executeImportBundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(executeImport.error).toBeUndefined()
		expect(executeImport.result).toEqual({
			token: 'wake-secret-value',
			authority: wake.packageId,
		})

		const enterAsA = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			await buildKodyModuleBundle({
				env,
				baseUrl: 'https://kody.dev',
				userId,
				sourceFiles: {
					'package.json': JSON.stringify({
						name: '@kentcdodds/grok-bot',
						exports: { './wake': './src/wake.ts' },
						kody: {
							id: 'grok-bot',
							secretMounts: {
								wakeToken: { name: 'wakeToken', scope: 'user' },
							},
						},
					}),
					'src/wake.ts': [
						"import { packageSecrets } from 'kody:runtime'",
						'export default async function wake() {',
						'\treturn { token: await packageSecrets.get("wakeToken") }',
						'}',
					].join('\n'),
				},
				entryPoint: 'src/wake.ts',
				rootPackageId: wake.packageId,
			}),
			undefined,
			{
				skipCapabilityRegistry: true,
				packageContext: {
					packageId: wake.packageId,
					kodyId: 'grok-bot',
					sourceId: wake.sourceId,
				},
			},
		)
		expect(enterAsA.error).toBeUndefined()
		expect(enterAsA.result).toEqual({ token: 'wake-secret-value' })

		const runAsBImportA = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			await buildKodyModuleBundle({
				env,
				baseUrl: 'https://kody.dev',
				userId,
				sourceFiles: {
					'package.json': JSON.stringify({
						name: '@kentcdodds/dependent',
						kody: {
							id: 'dependent',
							dependencies: { '@kentcdodds/grok-bot': '*' },
						},
					}),
					'src/run.ts': [
						"import wake from 'kody:@kentcdodds/grok-bot/wake'",
						'export default async function run() {',
						'\treturn await wake()',
						'}',
					].join('\n'),
				},
				entryPoint: 'src/run.ts',
				rootPackageId: importer.packageId,
			}),
			undefined,
			{
				skipCapabilityRegistry: true,
				packageContext: {
					packageId: importer.packageId,
					kodyId: 'dependent',
					sourceId: importer.sourceId,
				},
			},
		)
		expect(runAsBImportA.error).toBeUndefined()
		expect(runAsBImportA.result).toEqual({
			token: 'wake-secret-value',
			authority: wake.packageId,
		})

		const runAsBSteal = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			await buildKodyModuleBundle({
				env,
				baseUrl: 'https://kody.dev',
				userId,
				sourceFiles: {
					'package.json': JSON.stringify({
						name: '@kentcdodds/dependent',
						kody: {
							id: 'dependent',
							description: 'Dependent',
							secretMounts: {
								wakeToken: { name: 'wakeToken', scope: 'user' },
							},
						},
					}),
					'src/steal.ts': [
						"import { packageSecrets } from 'kody:runtime'",
						'export default async function steal() {',
						'\ttry {',
						'\t\treturn { token: await packageSecrets.get("wakeToken") }',
						'\t} catch (error) {',
						'\t\treturn { error: error instanceof Error ? error.message : String(error) }',
						'\t}',
						'}',
					].join('\n'),
				},
				entryPoint: 'src/steal.ts',
				rootPackageId: importer.packageId,
			}),
			undefined,
			{
				skipCapabilityRegistry: true,
				packageContext: {
					packageId: importer.packageId,
					kodyId: 'dependent',
					sourceId: importer.sourceId,
				},
			},
		)
		expect(runAsBSteal.error).toBeUndefined()
		expect(runAsBSteal.result).toEqual(
			expect.objectContaining({
				error: expect.stringMatching(/not allowed for package/i),
			}),
		)

		const executeUnstamped = await runBundledModuleWithRegistry(
			env,
			createCallerContext(userId),
			await buildKodyModuleBundle({
				env,
				baseUrl: 'https://kody.dev',
				userId,
				sourceFiles: {
					'entry.ts': [
						"import { packageSecrets } from 'kody:runtime'",
						'export default async function main() {',
						'\treturn { bound: packageSecrets != null }',
						'}',
					].join('\n'),
				},
				entryPoint: 'entry.ts',
			}),
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(executeUnstamped.error).toBeUndefined()
		expect(executeUnstamped.result).toEqual({ bound: false })
	},
)
