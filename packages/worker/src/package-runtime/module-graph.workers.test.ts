import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createWorker } from '@cloudflare/worker-bundler'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
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

test('worker bundler executes the wrapper when multiple package artifact defaults are imported', async () => {
	silenceIncidentalRuntimeWarnings()
	const bundle = await createWorker({
		files: {
			'.__kody_root__/.__kody_execute_entry__.js': [
				'import userEntrypoint from "./entry.js"',
				'export default async function __kodyExecuteEntrypoint(input) {',
				'\treturn await userEntrypoint(input)',
				'}',
			].join('\n'),
			'.__kody_root__/entry.js': [
				'import listTraces from "../.__kody_virtual__/imports/list-traces.js"',
				'import smokeTest from "../.__kody_virtual__/imports/smoke-test.js"',
				'import workflowDiscord from "../.__kody_virtual__/imports/workflow-discord.js"',
				'export default async function main() {',
				'\treturn {',
				'\t\tlistTraces: { staticType: typeof listTraces },',
				'\t\tsmokeTest: { staticType: typeof smokeTest },',
				'\t\tworkflowDiscord: { staticType: typeof workflowDiscord },',
				'\t}',
				'}',
			].join('\n'),
			'.__kody_virtual__/imports/list-traces.js': [
				'export * from "../published/list-traces.js"',
				'import * as module from "../published/list-traces.js"',
				'export default module.default',
			].join('\n'),
			'.__kody_virtual__/imports/smoke-test.js': [
				'export * from "../published/smoke-test.js"',
				'import * as module from "../published/smoke-test.js"',
				'export default module.default',
			].join('\n'),
			'.__kody_virtual__/imports/workflow-discord.js': [
				'export * from "../published/workflow-discord.js"',
				'import * as module from "../published/workflow-discord.js"',
				'export default module.default',
			].join('\n'),
			'.__kody_virtual__/published/list-traces.js': [
				'export default async function listTraces() {',
				'\treturn { traces: [] }',
				'}',
			].join('\n'),
			'.__kody_virtual__/published/smoke-test.js': [
				'export default async function smokeTest() {',
				'\treturn { smoke: true }',
				'}',
			].join('\n'),
			'.__kody_virtual__/published/workflow-discord.js': [
				'export default async function workflowDiscord() {',
				'\treturn { discord: true }',
				'}',
			].join('\n'),
		},
		entryPoint: '.__kody_root__/.__kody_execute_entry__.js',
	})

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
		listTraces: {
			staticType: 'function',
		},
		smokeTest: {
			staticType: 'function',
		},
		workflowDiscord: {
			staticType: 'function',
		},
	})
})

test('saved package artifact imports keep the execute wrapper as the runtime entrypoint', async () => {
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
		kodyId: 'email-received-subscriber',
		name: '@kentcdodds/email-received-subscriber',
		sourceId,
		publishedCommit,
	})
	const sourceFiles = {
		'package.json': JSON.stringify({
			name: '@kentcdodds/email-received-subscriber',
			exports: {
				'./list-traces': './src/list-traces.ts',
				'./smoke-test': './src/package-smoke-test.ts',
				'./workflow-discord-message-created':
					'./src/workflow-discord-message-created.ts',
			},
			kody: {
				id: 'email-received-subscriber',
				description: 'Email received subscriber',
			},
		}),
		'src/list-traces.ts':
			'export default async function listTraces() { return { traces: [] } }',
		'src/package-smoke-test.ts':
			'export default async function smokeTest() { return { smoke: true } }',
		'src/workflow-discord-message-created.ts':
			'export default async function workflowDiscord() { return { discord: true } }',
	}
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source,
		snapshot: {
			files: sourceFiles,
		},
	})
	for (const target of [
		{
			artifactName: './list-traces',
			entryPoint: 'src/list-traces.ts',
		},
		{
			artifactName: './smoke-test',
			entryPoint: 'src/package-smoke-test.ts',
		},
		{
			artifactName: './workflow-discord-message-created',
			entryPoint: 'src/workflow-discord-message-created.ts',
		},
	]) {
		const artifactBundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles,
			entryPoint: target.entryPoint,
		})
		await persistPublishedBundleArtifact({
			env,
			userId,
			source,
			kind: 'importable-module',
			artifactName: target.artifactName,
			entryPoint: target.entryPoint,
			mainModule: artifactBundle.mainModule,
			modules: artifactBundle.modules,
			dependencies: artifactBundle.dependencies,
			packageContext: {
				packageId,
				kodyId: 'email-received-subscriber',
				sourceId,
			},
		})
	}

	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId,
		sourceFiles: {
			'entry.ts': [
				"import listTraces from 'kody:@kentcdodds/email-received-subscriber/list-traces'",
				"import smokeTest from 'kody:@kentcdodds/email-received-subscriber/smoke-test'",
				"import workflowDiscord from 'kody:@kentcdodds/email-received-subscriber/workflow-discord-message-created'",
				"import { inspectNestedImport } from './src/deep/nested.ts'",
				'export default async function main() {',
				"\tconst dynamicListTraces = await import('kody:@kentcdodds/email-received-subscriber/list-traces')",
				'\tconst nestedImport = await inspectNestedImport()',
				'\treturn {',
				'\t\tlistTraces: { staticType: typeof listTraces },',
				'\t\tsmokeTest: { staticType: typeof smokeTest },',
				'\t\tworkflowDiscord: { staticType: typeof workflowDiscord },',
				'\t\tdynamicListTraces: { defaultType: typeof dynamicListTraces.default },',
				'\t\tnestedImport,',
				'\t}',
				'}',
			].join('\n'),
			'src/deep/nested.ts': [
				'export async function inspectNestedImport() {',
				"\tconst dynamicListTraces = await import('kody:@kentcdodds/email-received-subscriber/list-traces')",
				'\treturn { defaultType: typeof dynamicListTraces.default }',
				'}',
			].join('\n'),
		},
		entryPoint: 'entry.ts',
	})
	const result = await runBundledModuleWithRegistry(
		env,
		createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId,
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
		listTraces: {
			staticType: 'function',
		},
		smokeTest: {
			staticType: 'function',
		},
		workflowDiscord: {
			staticType: 'function',
		},
		dynamicListTraces: {
			defaultType: 'function',
		},
		nestedImport: {
			defaultType: 'function',
		},
	})
})

test('subscription bundles refresh stale nested runtime modules from static package dependencies', async () => {
	silenceIncidentalRuntimeWarnings()
	const nestedRuntimeModule =
		'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/.__kody_virtual__/runtime.js'
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
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js': [
					"import runDependency from '../.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/index.js'",
					'',
					'export default async function subscription(input = {}) {',
					'\treturn await runDependency(input)',
					'}',
				].join('\n'),
				'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/index.js':
					[
						"import { kody } from './.__kody_virtual__/runtime.js'",
						'',
						'export default async function runDependency(input = {}) {',
						"\treturn await kody.service_start({ source: input.source ?? 'email' })",
						'}',
					].join('\n'),
				[nestedRuntimeModule]: [
					'const runtime = {}',
					'export const kody = runtime.kody',
					'export default runtime',
				].join('\n'),
			},
		},
		{ source: 'email' },
		{
			additionalTools: {
				service_start: async (args) => ({
					ok: true,
					args,
				}),
			},
			packageContext: {
				packageId: 'pkg-subscription',
				kodyId: 'email-subscriber',
				sourceId: 'source-subscription',
			},
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		ok: true,
		args: {
			source: 'email',
		},
	})
})

test('saved package execution passes input as the default export argument', async () => {
	silenceIncidentalRuntimeWarnings()
	const packageJson = JSON.stringify({
		name: '@kentcdodds/input-package',
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: 'input-package',
			description: 'Exercises explicit input arguments',
		},
	})
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'package.json': packageJson,
			'src/index.ts': [
				'export default async function main(input = {}) {',
				'\treturn { room: input.room, missing: input.missing ?? "defaulted" }',
				'}',
			].join('\n'),
		},
		entryPoint: 'src/index.ts',
	})

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
		{ room: 'office' },
		{
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		room: 'office',
		missing: 'defaulted',
	})
})

test('saved package execution exposes packages.invoke when package invoke tools are provided', async () => {
	silenceIncidentalRuntimeWarnings()
	const packageJson = JSON.stringify({
		name: '@kentcdodds/invoker-package',
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: 'invoker-package',
			description: 'Exercises package invocation runtime helper',
		},
	})
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'package.json': packageJson,
			'src/index.ts': [
				"import { kody, packageContext, packages } from 'kody:runtime'",
				'',
				'export default async function main(input = {}) {',
				'\t// Direct kody.package_invoke_checked should reject; packages.invokeChecked is the public API.',
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
				'\t\tpackageId: packageContext?.packageId ?? null,',
				"\t\thasCheck: typeof packages?.check === 'function',",
				"\t\thasInvoke: typeof packages?.invoke === 'function',",
				"\t\thasInvokeChecked: typeof packages?.invokeChecked === 'function',",
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
		entryPoint: 'src/index.ts',
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
			packageContext: {
				packageId: 'pkg-invoker',
				kodyId: 'invoker-package',
				sourceId: 'source-invoker',
			},
			packageInvokeTools: {
				check: async (input) => ({
					ok: true,
					invoke: input as {
						kodyId: string
						exportName: string
						params?: Record<string, unknown>
					},
					contract: {
						packageId: 'pkg-target',
						kodyId: 'target-package',
						name: '@kentcdodds/target-package',
						sourceId: 'source-target',
						publishedCommit: 'commit-1',
						exportName: './run',
						runtimeTarget: 'src/run.ts',
						warnings: [],
					},
				}),
				invoke: async (input) => {
					invokedInputs.push(input)
					return { ok: true, input }
				},
				invokeChecked: async (input) => {
					invokedInputs.push(input)
					return { ok: true, input }
				},
			},
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		packageId: 'pkg-invoker',
		hasCheck: true,
		hasInvoke: true,
		hasInvokeChecked: true,
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

test('ad hoc execute runtime exposes packages.invoke when package invoke tools are provided', async () => {
	silenceIncidentalRuntimeWarnings()
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'entry.ts': [
				"import { kody, packageContext, packages } from 'kody:runtime'",
				'',
				'export default async function main(input = {}) {',
				'\t// Direct kody.package_invoke_checked should reject; packages.invokeChecked is the public API.',
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
				"\t\thasInvokeChecked: typeof packages?.invokeChecked === 'function',",
				'\t\tdirectKodyInvokeChecked,',
				'\t\tinvoked: await packages?.invokeChecked({',
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
				check: async (input) => ({
					ok: true,
					invoke: input as {
						kodyId: string
						exportName: string
						params?: Record<string, unknown>
					},
					contract: {
						packageId: 'pkg-target',
						kodyId: 'target-package',
						name: '@kentcdodds/target-package',
						sourceId: 'source-target',
						publishedCommit: 'commit-1',
						exportName: './run',
						runtimeTarget: 'src/run.ts',
						warnings: [],
					},
				}),
				invoke: async (input) => {
					invokedInputs.push(input)
					return { ok: true, input }
				},
				invokeChecked: async (input) => {
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
		hasInvokeChecked: true,
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

test('ad hoc execute runtime exposes packages as null without package invoke tools', async () => {
	silenceIncidentalRuntimeWarnings()
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'entry.ts': [
				"import { packageContext, packages } from 'kody:runtime'",
				'',
				'export default async function main() {',
				'\treturn {',
				'\t\tpackageContextIsNull: packageContext === null,',
				'\t\tpackagesIsNull: packages === null,',
				"\t\thasInvoke: typeof packages?.invoke === 'function',",
				'\t}',
				'}',
			].join('\n'),
		},
		entryPoint: 'entry.ts',
	})

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
			packageContext: null,
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		packageContextIsNull: true,
		packagesIsNull: true,
		hasInvoke: false,
	})
})
