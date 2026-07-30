import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'

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

async function readStaticCallRollup(userId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT event_count, error_count, total_duration_ms
		FROM usage_rollups WHERE user_id = ?1 AND metric = 'package_static_call'`,
	)
		.bind(userId)
		.first<{
			event_count: number
			error_count: number
			total_duration_ms: number
		}>()
	return row ?? null
}

test(
	'statically imported package exports meter one package_static_call per call',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		await ensureUsageRollupsTestSchema(env.APP_DB)
		const unique = crypto.randomUUID()
		const userId = `user-${unique}`
		const packageId = `pkg-${unique}`
		const source = await insertSavedPackage({
			userId,
			packageId,
			kodyId: 'metered-dep',
			name: '@kentcdodds/metered-dep',
			sourceId: `source-${unique}`,
			publishedCommit: `commit-${unique}`,
		})
		await persistPublishedSourceSnapshot({
			env,
			userId,
			source,
			snapshot: {
				files: {
					'package.json': JSON.stringify({
						name: '@kentcdodds/metered-dep',
						exports: { '.': './src/index.ts' },
						kody: { id: 'metered-dep', description: 'Metered dependency' },
					}),
					'src/index.ts': [
						'export default async function compute(input: number) {',
						'\treturn { doubled: input * 2 }',
						'}',
						'export function throwWhenAsked(shouldThrow: boolean) {',
						"\tif (shouldThrow) throw new Error('asked to throw')",
						"\treturn 'calm'",
						'}',
						'export class Accumulator {',
						'\ttotal: number',
						'\tconstructor(start: number) {',
						'\t\tthis.total = start',
						'\t}',
						'\tbump() {',
						'\t\treturn ++this.total',
						'\t}',
						'}',
						'export const answer = 42',
					].join('\n'),
				},
			},
		})

		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import compute, { throwWhenAsked, Accumulator, answer } from 'kody:@kentcdodds/metered-dep'",
					'export default async function main() {',
					'\tconst first = await compute(1)',
					'\tconst second = await compute(2)',
					'\tconst third = await compute(3)',
					'\tlet thrownMessage = null',
					'\ttry {',
					'\t\tthrowWhenAsked(true)',
					'\t} catch (error) {',
					'\t\tthrownMessage = String(error instanceof Error ? error.message : error)',
					'\t}',
					'\t// The wrapper only traps [[Call]]: `new` on a wrapped class',
					'\t// constructs the real class (and is not metered).',
					'\tconst accumulator = new Accumulator(10)',
					'\treturn {',
					'\t\tfirst,',
					'\t\tsecond,',
					'\t\tthird,',
					'\t\tthrownMessage,',
					'\t\tcalm: throwWhenAsked(false),',
					'\t\tconstructed: accumulator.bump(),',
					'\t\tanswer,',
					'\t\tanswerType: typeof answer,',
					'\t}',
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
		// The throwing export still throws to the caller; class exports
		// construct through the wrapper; non-function exports pass through
		// unwrapped.
		expect(result.result).toEqual({
			first: { doubled: 2 },
			second: { doubled: 4 },
			third: { doubled: 6 },
			thrownMessage: 'asked to throw',
			calm: 'calm',
			constructed: 11,
			answer: 42,
			answerType: 'number',
		})

		// 3 default calls + 1 throwing call + 1 calm call = 5 events, 1 error.
		// Metering is fire-and-forget from the sandbox, so poll the rollup.
		await vi.waitFor(
			async () => {
				const rollup = await readStaticCallRollup(userId)
				expect(rollup).toEqual({
					event_count: 5,
					error_count: 1,
					total_duration_ms: expect.any(Number),
				})
			},
			{ timeout: 10_000, interval: 100 },
		)
	},
)

test(
	'published-artifact static imports meter calls and drop forged stamped ids',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		await ensureUsageRollupsTestSchema(env.APP_DB)
		const unique = crypto.randomUUID()
		const userId = `user-${unique}`
		const packageId = `pkg-${unique}`
		const source = await insertSavedPackage({
			userId,
			packageId,
			kodyId: 'artifact-dep',
			name: '@kentcdodds/artifact-dep',
			sourceId: `source-${unique}`,
			publishedCommit: `commit-${unique}`,
		})
		const sourceFiles = {
			'package.json': JSON.stringify({
				name: '@kentcdodds/artifact-dep',
				exports: { '.': './src/index.ts' },
				kody: { id: 'artifact-dep', description: 'Artifact dependency' },
			}),
			'src/index.ts': [
				'export default async function run() {',
				"\treturn 'artifact-ok'",
				'}',
				'export function greet(name: string) {',
				'\treturn `hello ${name}`',
				'}',
			].join('\n'),
		}
		await persistPublishedSourceSnapshot({
			env,
			userId,
			source,
			snapshot: { files: sourceFiles },
		})
		const artifactBundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles,
			entryPoint: 'src/index.ts',
		})
		await persistPublishedBundleArtifact({
			env,
			userId,
			source,
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			mainModule: artifactBundle.mainModule,
			modules: artifactBundle.modules,
			dependencies: artifactBundle.dependencies,
			packageContext: {
				packageId,
				kodyId: 'artifact-dep',
				sourceId: source.id,
			},
		})

		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import run, { greet } from 'kody:@kentcdodds/artifact-dep'",
					"import { __kodyMeterStaticPackageExport } from 'kody:runtime'",
					'export default async function main() {',
					'\t// Forge a stamp for a package this bundle does not statically',
					'\t// depend on: the host must drop it silently.',
					'\tconst forged = __kodyMeterStaticPackageExport(',
					"\t\t'pkg-not-a-dependency',",
					"\t\t() => 'forged-ok',",
					'\t)',
					'\tconst forgedValue = forged()',
					'\treturn { ran: await run(), greeting: greet("kody"), forgedValue }',
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
			ran: 'artifact-ok',
			greeting: 'hello kody',
			forgedValue: 'forged-ok',
		})

		// The forged event fires before the two granted ones; once the granted
		// events land, a count of exactly 2 proves the forged stamp was
		// dropped by the host-side dependency-provenance check.
		await vi.waitFor(
			async () => {
				const rollup = await readStaticCallRollup(userId)
				expect(rollup).toEqual({
					event_count: 2,
					error_count: 0,
					total_duration_ms: expect.any(Number),
				})
			},
			{ timeout: 10_000, interval: 100 },
		)
		// Guard against the count racing past 2 after the wait: re-read once
		// everything in flight has had time to settle.
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(await readStaticCallRollup(userId)).toEqual(
			expect.objectContaining({ event_count: 2 }),
		)
	},
)
