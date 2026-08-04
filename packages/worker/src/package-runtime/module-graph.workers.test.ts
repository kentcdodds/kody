import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { createExecutePackageInvokeTools } from '#worker/package-invocations/service.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

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
		created_at: '2026-05-13T00:00:00.000Z',
		updated_at: '2026-05-13T00:00:00.000Z',
	}
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
	return createSourceRow(input)
}

test(
	'saved package bundles and executes npm dependencies declared in package.json',
	{ timeout: 20_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const packageJson = JSON.stringify({
			name: '@kentcdodds/dependency-package',
			exports: {
				'.': './src/index.ts',
			},
			dependencies: {
				kleur: '^4.1.5',
			},
			kody: {
				id: 'dependency-package',
				description: 'Exercises npm dependency bundling',
			},
		})

		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: 'user-workers-test',
			sourceFiles: {
				'package.json': packageJson,
				'src/index.ts': [
					"import kleur from 'kleur'",
					'export default async function run() {',
					"\treturn { formatted: kleur.green('dependency-ok') }",
					'}',
				].join('\n'),
			},
			entryPoint: 'src/index.ts',
		})

		const moduleSources = Object.values(bundle.modules)
			.map((module) => {
				if (typeof module === 'string') return module
				return [module.js, module.cjs, module.text]
					.filter((value): value is string => typeof value === 'string')
					.join('\n')
			})
			.join('\n')
		expect(moduleSources).toContain('dependency-ok')
		expect(moduleSources).not.toContain(`from "kleur"`)

		const result = await runBundledModuleWithRegistry(
			env,
			createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: {
					userId: 'user-workers-test',
					email: 'worker@example.com',
					displayName: 'Worker Test',
				},
			}),
			{
				mainModule: bundle.mainModule,
				modules: bundle.modules,
			},
			undefined,
			{
				skipCapabilityRegistry: true,
			},
		)

		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			formatted: 'dependency-ok',
		})
	},
)

test('ad hoc execute runtime exposes packages.invoke and rejects unsupported helpers', async () => {
	silenceIncidentalRuntimeWarnings()
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'entry.ts': [
				"import { kody, packageContext, packages } from 'kody:runtime'",
				'',
				'const captureError = (fn) => {',
				'\ttry {',
				'\t\tfn()',
				"\t\treturn 'resolved'",
				'\t} catch (error) {',
				'\t\treturn String(error?.message ?? error)',
				'\t}',
				'}',
				'',
				'export default async function main(input = {}) {',
				'\t// Direct kody.package_invoke_checked should reject; packages.invoke is the public API.',
				'\tlet directKodyInvokeChecked;',
				'\ttry {',
				'\t\tawait kody.package_invoke_checked({',
				"\t\t\tkodyId: 'target-package',",
				"\t\t\texportName: './run',",
				'\t\t});',
				"\t\tdirectKodyInvokeChecked = 'resolved';",
				'\t} catch (error) {',
				'\t\tdirectKodyInvokeChecked = String(error?.message ?? error);',
				'\t}',
				'\treturn {',
				'\t\tpackageContextIsNull: packageContext === null,',
				'\t\tremovedCheckError: captureError(() => packages?.check({})),',
				'\t\tremovedInvokeCheckedError: captureError(() => packages?.invokeChecked({})),',
				'\t\tdirectKodyInvokeChecked,',
				'\t\tinvoked: await packages?.invoke({',
				"\t\t\tkodyId: 'target-package',",
				"\t\t\texportName: './run',",
				'\t\t\tparams: input,',
				'\t\t}),',
				'\t}',
				'}',
			].join('\n'),
		},
		entryPoint: 'entry.ts',
	})
	const invokedInputs: Array<Record<string, unknown>> = []
	const result = await runBundledModuleWithRegistry(
		env,
		createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-workers-test',
				email: 'worker@example.com',
				displayName: 'Worker Test',
			},
		}),
		{
			mainModule: bundle.mainModule,
			modules: bundle.modules,
		},
		{ eventId: 'event-1' },
		{
			packageContext: null,
			packageInvokeTools: {
				invoke: async (input) => {
					invokedInputs.push(input)
					return { ok: true, input }
				},
			},
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		packageContextIsNull: true,
		removedCheckError: expect.stringContaining('packages.check was removed'),
		removedInvokeCheckedError: expect.stringContaining(
			'packages.invokeChecked was removed',
		),
		directKodyInvokeChecked: expect.stringContaining('package_invoke_checked'),
		invoked: {
			ok: true,
			input: {
				kodyId: 'target-package',
				exportName: './run',
				params: { eventId: 'event-1' },
			},
		},
	})
	expect(
		(result.result as { directKodyInvokeChecked: unknown })
			.directKodyInvokeChecked,
	).not.toBe('resolved')
	expect(invokedInputs).toEqual([
		{
			kodyId: 'target-package',
			exportName: './run',
			params: { eventId: 'event-1' },
		},
	])
})

test(
	'key-less packages.invoke runs the target package lean in its own realm',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSavedPackageArtifactSchema()
		const unique = crypto.randomUUID()
		const userId = `user-${unique}`
		const sourceId = `source-${unique}`
		const packageId = `pkg-${unique}`
		const publishedCommit = `commit-${unique}`
		const source = await insertSavedPackage({
			userId,
			packageId,
			kodyId: 'lean-target',
			name: '@kentcdodds/lean-target',
			sourceId,
			publishedCommit,
		})
		const targetSourceFiles = {
			'package.json': JSON.stringify({
				name: '@kentcdodds/lean-target',
				exports: {
					'./probe': './src/probe.ts',
				},
				kody: {
					id: 'lean-target',
					description: 'Lean invoke probe target',
				},
			}),
			'src/probe.ts': [
				"import { packageContext } from 'kody:runtime'",
				'',
				'let isolateCallCount = 0',
				'',
				'export default async function probe(input: { marker?: string } = {}) {',
				'\tisolateCallCount += 1',
				";(globalThis as Record<string, unknown>).__kodyLeanTargetMarker = 'target'",
				'\treturn {',
				'\t\tmarker: input.marker ?? null,',
				'\t\tisolateCallCount,',
				'\t\ttargetKodyId: packageContext?.kodyId ?? null,',
				"\t\tcallerMarkerVisible: typeof (globalThis as Record<string, unknown>).__kodyLeanCallerMarker !== 'undefined',",
				'\t}',
				'}',
			].join('\n'),
		}
		await persistPublishedSourceSnapshot({
			env,
			userId,
			source,
			snapshot: {
				files: targetSourceFiles,
			},
		})
		const artifactBundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: targetSourceFiles,
			entryPoint: 'src/probe.ts',
		})
		await persistPublishedBundleArtifact({
			env,
			userId,
			source,
			kind: 'importable-module',
			artifactName: './probe',
			entryPoint: 'src/probe.ts',
			mainModule: artifactBundle.mainModule,
			modules: artifactBundle.modules,
			dependencies: artifactBundle.dependencies,
			packageContext: {
				packageId,
				kodyId: 'lean-target',
				sourceId,
			},
		})

		const callerBundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import { packages } from 'kody:runtime'",
					'',
					'const captureError = (fn: () => unknown) => {',
					'\ttry {',
					'\t\tfn()',
					"\t\treturn 'resolved'",
					'\t} catch (error) {',
					'\t\treturn String((error as Error)?.message ?? error)',
					'\t}',
					'}',
					'',
					'export default async function main() {',
					";(globalThis as Record<string, unknown>).__kodyLeanCallerMarker = 'caller'",
					'\tconst startedAt = Date.now()',
					"\tconst first = await packages?.invoke({ kodyId: 'lean-target', exportName: './probe', params: { marker: 'first' } })",
					'\tconst firstDurationMs = Date.now() - startedAt',
					"\tconst second = await packages?.invoke({ kodyId: 'lean-target', exportName: './probe', params: { marker: 'second' } })",
					"\tconst removedInvokeCheckedError = captureError(() => packages?.invokeChecked({ kodyId: 'lean-target', exportName: './probe' }))",
					"\tconst removedCheckError = captureError(() => packages?.check({ kodyId: 'lean-target', exportName: './probe' }))",
					'\treturn {',
					'\t\tfirst,',
					'\t\tsecond,',
					'\t\tremovedInvokeCheckedError,',
					'\t\tremovedCheckError,',
					'\t\tfirstDurationMs,',
					"\t\ttargetMarkerVisible: typeof (globalThis as Record<string, unknown>).__kodyLeanTargetMarker !== 'undefined',",
					'\t}',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId,
				email: 'worker@example.com',
				displayName: 'Worker Test',
			},
		})
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			{
				mainModule: callerBundle.mainModule,
				modules: callerBundle.modules,
			},
			undefined,
			{
				packageContext: null,
				packageInvokeTools: createExecutePackageInvokeTools({
					env,
					baseUrl: 'https://kody.dev',
					callerContext,
				}),
				skipCapabilityRegistry: true,
			},
		)

		expect(result.error).toBeUndefined()
		const payload = result.result as {
			first: Record<string, unknown>
			second: Record<string, unknown>
			removedInvokeCheckedError: string
			removedCheckError: string
			firstDurationMs: number
			targetMarkerVisible: boolean
		}
		// The target ran in its own runtime (packageContext bound to the target
		// package) and each key-less invoke got a fresh isolate.
		expect(payload.first).toEqual({
			marker: 'first',
			isolateCallCount: 1,
			targetKodyId: 'lean-target',
			callerMarkerVisible: false,
		})
		expect(payload.second).toEqual({
			marker: 'second',
			isolateCallCount: 1,
			targetKodyId: 'lean-target',
			callerMarkerVisible: false,
		})
		// Unsupported helpers throw teaching errors naming the replacement.
		expect(payload.removedInvokeCheckedError).toContain(
			'packages.invokeChecked was removed',
		)
		expect(payload.removedCheckError).toContain('packages.check was removed')
		// Realm separation in the other direction: the target's globals never
		// leak back into the caller realm.
		expect(payload.targetMarkerVisible).toBe(false)
		// Sanity bound only: workerd test timing is too noisy for a strict
		// budget; the production lean-path latency claim is validated by live
		// probes, not this test.
		expect(payload.firstDurationMs).toBeLessThan(20_000)
	},
)
