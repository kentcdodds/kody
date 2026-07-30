import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { persistPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Regression coverage for the production `execute-pre-exec-typecheck`
 * incident: nested `kody.execute` calls (the handler runs
 * `runModuleWithRegistry` inside a ToolDispatcher RPC callback while the
 * outer sandbox `evaluate()` is in flight) and modules statically importing
 * real packages hung for minutes and stranded run records as `running`
 * before the pre-exec check stopped running a TypeScript compiler inside
 * the MCP isolate.
 */

function createCaller(userId: string) {
	return createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId,
			email: `${userId}@example.com`,
			displayName: 'Nested Typecheck',
		},
	})
}

test(
	'nested executes with preExecTypecheck on complete with correct results',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-nested-typecheck'
		const caller = createCaller(userId)
		const nestedCodeOne =
			'export default async function main() {\n\treturn 40 + 2\n}'
		const nestedCodeTwo =
			"export default async function main() {\n\treturn 'nested-two'\n}"
		const outerSource = [
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			`\tconst first = await kody.nested_execute({ code: ${JSON.stringify(nestedCodeOne)} })`,
			`\tconst second = await kody.nested_execute({ code: ${JSON.stringify(nestedCodeTwo)} })`,
			'\treturn { first, second }',
			'}',
		].join('\n')

		const startedAtMs = Date.now()
		const result = await runModuleWithRegistry(
			env,
			caller,
			outerSource,
			undefined,
			{
				preExecTypecheck: true,
				skipCapabilityRegistry: true,
				additionalTools: {
					// Mirrors the meta `execute` capability handler: a nested
					// runModuleWithRegistry with preExecTypecheck on, running
					// host-side inside the dispatcher RPC callback.
					nested_execute: async (args: unknown) =>
						await runModuleWithRegistry(
							env,
							caller,
							(args as { code: string }).code,
							undefined,
							{
								preExecTypecheck: true,
								skipCapabilityRegistry: true,
							},
						),
				},
			},
		)
		const elapsedMs = Date.now() - startedAtMs
		expect(result.error).toBeUndefined()
		expect(result.result).toMatchObject({
			first: { result: 42 },
			second: { result: 'nested-two' },
		})
		// The production defect stranded these runs for 180s+ (stale-running
		// TTL); a healthy nested pipeline completes in single-digit seconds.
		expect(elapsedMs).toBeLessThan(60_000)
	},
)

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

/**
 * Same minimal saved-package schema as
 * `execute-nested-preexec-typecheck.workers.test.ts` (workers-unit D1 does
 * not run app migrations).
 */
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

async function saveLargePackage(input: { userId: string }) {
	const unique = crypto.randomUUID()
	const packageId = `package-${unique}`
	const sourceId = `source-${unique}`
	const now = new Date().toISOString()
	const packageName = '@kentcdodds/oversized-graph'
	const files: Record<string, string> = {
		'package.json': JSON.stringify({
			name: packageName,
			exports: { '.': './src/index.ts' },
			kody: { id: 'oversized-graph', description: 'Oversized graph fixture' },
		}),
		'src/index.ts':
			'export default async function call(input: { name: string }) { return { message: `Hello, ${input.name}` } }',
	}
	// The production incident graphs (@kentcdodds/discord: 67 files/~692KB)
	// OOM-killed the MCP isolate when the removed compiler loaded them.
	for (let index = 0; index < 30; index += 1) {
		files[`src/generated-${index}.ts`] =
			`export const filler${index} = ${JSON.stringify('x'.repeat(4096))}\n`
	}
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, 'oversized-graph', ?, '[]', NULL, ?, 0, ?, ?)`,
		packageId,
		input.userId,
		packageName,
		'Oversized graph fixture',
		sourceId,
		now,
		now,
	)
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		sourceId,
		input.userId,
		packageId,
		`repo-${sourceId}`,
		`commit-${unique}`,
		now,
		now,
	)
	await persistPublishedSourceSnapshot({
		env,
		userId: input.userId,
		source: {
			id: sourceId,
			user_id: input.userId,
			entity_kind: 'package',
			entity_id: packageId,
			repo_id: `repo-${sourceId}`,
			published_commit: `commit-${unique}`,
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: now,
			updated_at: now,
		},
		snapshot: { files },
	})
}

test(
	'nested execute statically importing a large package completes end-to-end',
	{ timeout: 120_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = `user-oversized-${crypto.randomUUID()}`
		await ensureSavedPackageSchema()
		await saveLargePackage({ userId })
		const caller = createCaller(userId)
		const nestedCode = [
			"import call from 'kody:@kentcdodds/oversized-graph'",
			'export default async function main() {',
			"\treturn await call({ name: 'Ada' })",
			'}',
		].join('\n')
		const outerSource = [
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			`\treturn await kody.nested_execute({ code: ${JSON.stringify(nestedCode)} })`,
			'}',
		].join('\n')
		const result = await runModuleWithRegistry(
			env,
			caller,
			outerSource,
			undefined,
			{
				preExecTypecheck: true,
				skipCapabilityRegistry: true,
				additionalTools: {
					nested_execute: async (args: unknown) =>
						await runModuleWithRegistry(
							env,
							caller,
							(args as { code: string }).code,
							undefined,
							{
								preExecTypecheck: true,
								skipCapabilityRegistry: true,
							},
						),
				},
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toMatchObject({
			result: { message: 'Hello, Ada' },
		})
		const nestedServerTiming = (
			result.result as {
				serverTiming: Array<{ name: string }>
			}
		).serverTiming
		expect(nestedServerTiming.map((entry) => entry.name)).toContain(
			'typecheck-semantic-skipped',
		)
	},
)
