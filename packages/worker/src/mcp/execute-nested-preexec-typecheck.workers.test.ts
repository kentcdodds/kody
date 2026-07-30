import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runBundledModuleWithRegistry,
	runModuleWithRegistry,
} from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { persistPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSavedPackageSchema() {
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

async function saveStaticContractPackage(input: {
	userId: string
	packageId: string
	sourceId: string
	publishedCommit: string
}) {
	const now = new Date().toISOString()
	const packageName = '@kentcdodds/nested-static-contract'
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, 'nested-static-contract', ?, '[]', NULL, ?, 0, ?, ?)`,
		input.packageId,
		input.userId,
		packageName,
		'Nested static contract fixture',
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
	await persistPublishedSourceSnapshot({
		env,
		userId: input.userId,
		source: {
			id: input.sourceId,
			user_id: input.userId,
			entity_kind: 'package',
			entity_id: input.packageId,
			repo_id: `repo-${input.sourceId}`,
			published_commit: input.publishedCommit,
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: now,
			updated_at: now,
		},
		snapshot: {
			files: {
				'package.json': JSON.stringify({
					name: packageName,
					exports: {
						'.': {
							import: './src/index.ts',
							types: './types/index.d.ts',
						},
					},
					kody: {
						id: 'nested-static-contract',
						description: 'Nested static contract fixture',
					},
				}),
				'src/index.ts':
					'export default async function greet(input: { name: string }) { return { message: `Hello, ${input.name}` } }',
				'types/index.d.ts':
					'export default function greet(input: { name: string }): Promise<{ message: string }>',
			},
		},
	})
}

test(
	'nested execute with pre-exec typecheck and a static Kody import reaches its sandbox',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageSchema()
		const unique = crypto.randomUUID()
		const userId = `user-${unique}`
		await saveStaticContractPackage({
			userId,
			packageId: `package-${unique}`,
			sourceId: `source-${unique}`,
			publishedCommit: `commit-${unique}`,
		})
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId,
				email: 'nested@example.com',
				displayName: 'Nested Execute Test',
			},
		})
		const outerBundle = await buildKodyModuleBundle({
			env,
			baseUrl: callerContext.baseUrl,
			userId,
			sourceFiles: {
				'entry.ts': [
					"import { kody } from 'kody:runtime'",
					'export default async function main() {',
					"\treturn await kody.nested_execute({ marker: 'from-sandbox' })",
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const runNested = async (innerCode: string) =>
			await runBundledModuleWithRegistry(
				env,
				callerContext,
				{
					mainModule: outerBundle.mainModule,
					modules: outerBundle.modules,
				},
				undefined,
				{
					skipCapabilityRegistry: true,
					additionalTools: {
						nested_execute: async () =>
							await runModuleWithRegistry(
								env,
								callerContext,
								innerCode,
								undefined,
								{
									preExecTypecheck: true,
								},
							),
					},
				},
			)

		const invalid = await runNested(
			[
				"import greet from 'kody:@kentcdodds/nested-static-contract'",
				'export default async function main() {',
				'\treturn await greet({ name: 42 })',
				'}',
			].join('\n'),
		)
		expect(invalid.error).toContain(
			"Type 'number' is not assignable to type 'string'",
		)

		const nested = await runNested(
			[
				"import greet from 'kody:@kentcdodds/nested-static-contract'",
				'export default async function main() {',
				"\treturn await greet({ name: 'Ada' })",
				'}',
			].join('\n'),
		)
		expect(nested.error).toBeUndefined()
		expect(nested.result).toMatchObject({
			result: { message: 'Hello, Ada' },
			serverTiming: expect.arrayContaining([
				expect.objectContaining({ name: 'typecheck-total' }),
				expect.objectContaining({ name: 'sandbox' }),
			]),
		})
	},
)
