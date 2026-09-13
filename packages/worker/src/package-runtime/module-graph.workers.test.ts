import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createAdHocExecuteSourceFiles,
	runBundledModuleWithRegistry,
} from '#mcp/run-kody-registry.ts'
import { createExecutePackageInvokeTools } from '#worker/package-invocations/service.ts'
import {
	buildKodyAppClientBundle,
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { packageAppClientModuleNamePattern } from './package-app-client-module-name.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

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
		locked_at TEXT,
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
	try {
		await runSql(`ALTER TABLE saved_packages ADD COLUMN locked_at TEXT`)
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

test(
	'ad hoc execute synthesizes and executes npm dependencies through the bundler',
	{ timeout: 20_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const sourceFiles = createAdHocExecuteSourceFiles(
			[
				"import kleur from 'kleur'",
				'export default function main() {',
				"\treturn { formatted: kleur.green('ad-hoc-dependency-ok') }",
				'}',
			].join('\n'),
		)
		expect(JSON.parse(sourceFiles['package.json'] ?? '{}')).toEqual({
			dependencies: { kleur: 'latest' },
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: 'user-ad-hoc-npm-test',
			sourceFiles,
			entryPoint: 'entry.ts',
			bundleContext: 'ad-hoc-execute',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: {
					userId: 'user-ad-hoc-npm-test',
					email: 'worker@example.com',
					displayName: 'Worker Test',
				},
			}),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)

		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({ formatted: 'ad-hoc-dependency-ok' })
	},
)

test('ad hoc execute runtime exposes only packages.invoke', async () => {
	silenceIncidentalRuntimeWarnings()
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		bundleContext: 'ad-hoc-execute',
		sourceFiles: {
			'entry.ts': [
				"import { kody, packageContext, packages } from 'kody:runtime'",
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
				'\tlet removedObjectInvoke;',
				'\ttry {',
				'\t\tawait packages?.invoke({ kodyId: "target-package", exportName: "./run" });',
				"\t\tremovedObjectInvoke = 'resolved';",
				'\t} catch (error) {',
				'\t\tremovedObjectInvoke = String(error?.message ?? error);',
				'\t}',
				'\treturn {',
				'\t\tpackageContextIsNull: packageContext?.packageId == null,',
				'\t\tdirectKodyInvokeChecked,',
				'\t\tremovedObjectInvoke,',
				'\t\tinvoked: await packages?.invoke(',
				'\t\t\t"kody:@owner/target-package/run",',
				'\t\t\t{ params: input },',
				'\t\t),',
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
		directKodyInvokeChecked: expect.stringContaining('package_invoke_checked'),
		removedObjectInvoke: expect.stringContaining(
			'Object-only packages.invoke was removed',
		),
		invoked: {
			ok: true,
			input: {
				specifier: 'kody:@owner/target-package/run',
				options: { params: { eventId: 'event-1' } },
			},
		},
	})
	expect(
		(result.result as { directKodyInvokeChecked: unknown })
			.directKodyInvokeChecked,
	).not.toBe('resolved')
	expect(invokedInputs).toEqual([
		{
			specifier: 'kody:@owner/target-package/run',
			options: { params: { eventId: 'event-1' } },
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
		await ensureUsersTestSchema({ db: env.APP_DB })
		await runSql(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES (?, ?, ?, ?)`,
			`worker-${unique}`,
			`worker-${unique}@example.com`,
			'test-password-hash',
			userId,
		)
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
			bundleContext: 'ad-hoc-execute',
			sourceFiles: {
				'entry.ts': [
					"import { packages } from 'kody:runtime'",
					'',
					'export default async function main() {',
					";(globalThis as Record<string, unknown>).__kodyLeanCallerMarker = 'caller'",
					'\tconst startedAt = Date.now()',
					"\tconst first = await packages?.invoke('kody:@kentcdodds/lean-target/probe', { params: { marker: 'first' } })",
					'\tconst firstDurationMs = Date.now() - startedAt',
					"\tconst second = await packages?.invoke('kody:@kentcdodds/lean-target/probe', { params: { marker: 'second' } })",
					'\treturn {',
					'\t\tfirst,',
					'\t\tsecond,',
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
			firstDurationMs: number
			targetMarkerVisible: boolean
		}
		// The target ran in its own runtime (packageContext bound to the target
		// package). Same user + published graph reuse one isolate; params arrive
		// on evaluate RPC, so the second invoke sees the module-level counter.
		expect(payload.first).toEqual({
			marker: 'first',
			isolateCallCount: 1,
			targetKodyId: 'lean-target',
			callerMarkerVisible: false,
		})
		expect(payload.second).toEqual({
			marker: 'second',
			isolateCallCount: 2,
			targetKodyId: 'lean-target',
			callerMarkerVisible: false,
		})
		// Realm separation in the other direction: the target's globals never
		// leak back into the caller realm.
		expect(payload.targetMarkerVisible).toBe(false)
		// Sanity bound only: workerd test timing is too noisy for a strict
		// budget; the production lean-path latency claim is validated by live
		// probes, not this test.
		expect(payload.firstDurationMs).toBeLessThan(20_000)
	},
)

test(
	'kody.app.client bundles TypeScript for the browser into one fingerprinted ESM module',
	{ timeout: 20_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const packageJson = JSON.stringify({
			name: '@kentcdodds/browser-client',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'browser-client',
				description: 'Exercises the browser client bundle',
				app: {
					entry: './src/app.ts',
					client: './src/client.ts',
				},
			},
		})
		const sourceFiles = {
			'package.json': packageJson,
			'src/index.ts': 'export default async () => ({ ok: true })',
			'src/app.ts': [
				"import { packageContext } from 'kody:runtime'",
				'export default {',
				'\tasync fetch() {',
				'\t\treturn new Response(packageContext?.clientModuleUrl ?? "")',
				'\t},',
				'}',
			].join('\n'),
			'src/client.ts': [
				"import { render } from './render.ts'",
				'',
				'type Greeting = { name: string }',
				'const greeting: Greeting = { name: "browser" }',
				'export const mounted = render(greeting.name)',
			].join('\n'),
			'src/render.ts': [
				'export function render(name: string) {',
				'\treturn `hello ${name}`',
				'}',
			].join('\n'),
		}

		const bundle = await buildKodyAppClientBundle({
			sourceFiles,
			entryPoint: 'src/client.ts',
		})

		expect(bundle.mainModule).toMatch(packageAppClientModuleNamePattern)
		expect(Object.keys(bundle.modules)).toEqual([bundle.mainModule])
		const source = bundle.modules[bundle.mainModule]
		expect(typeof source).toBe('string')
		const code = source as string
		// Browser ESM: TypeScript stripped, relative graph inlined, no imports
		// left for the browser to resolve, and the export surface preserved.
		expect(code).not.toContain('type Greeting')
		expect(code).not.toMatch(/\bimport\b/)
		expect(code).toContain('hello ${name}')
		expect(code).toMatch(/export\s*\{/)

		const rebuilt = await buildKodyAppClientBundle({
			sourceFiles,
			entryPoint: 'src/client.ts',
		})
		expect(rebuilt.mainModule).toBe(bundle.mainModule)

		await expect(
			buildKodyAppClientBundle({
				sourceFiles: {
					...sourceFiles,
					'src/client.ts': [
						"import { packageContext } from 'kody:runtime'",
						'console.log(packageContext)',
					].join('\n'),
				},
				entryPoint: 'src/client.ts',
			}),
		).rejects.toThrow(/server-only modules that cannot run in the browser/)

		// Declared externals survive esbuild as bare imports for the page's
		// import map; the relative graph is still inlined around them.
		const importMapPackageJson = JSON.stringify({
			...JSON.parse(packageJson),
			kody: {
				...JSON.parse(packageJson).kody,
				app: {
					entry: './src/app.ts',
					client: { entry: './src/client.ts', externals: ['@remix-run/ui'] },
				},
			},
		})
		const withExternals = await buildKodyAppClientBundle({
			sourceFiles: {
				...sourceFiles,
				'package.json': importMapPackageJson,
				'src/client.ts': [
					"import { Button } from '@remix-run/ui'",
					"import { render } from './render.ts'",
					'export const mounted = render(String(Button))',
				].join('\n'),
			},
			entryPoint: 'src/client.ts',
		})
		const externalCode = withExternals.modules[withExternals.mainModule]
		expect(externalCode).toMatch(/from\s+"@remix-run\/ui"/)
		expect(externalCode).toContain('hello ${name}')
		expect(externalCode).not.toMatch(/from\s+["']\.\/render/)

		// Subpaths of a declared external stay external too, but a package that
		// merely shares the prefix is not silently externalized: it is an
		// unresolved bare import and fails publish with the externals hint.
		const subpathPackageJson = JSON.stringify({
			...JSON.parse(packageJson),
			kody: {
				...JSON.parse(packageJson).kody,
				app: {
					entry: './src/app.ts',
					client: { entry: './src/client.ts', externals: ['preact'] },
				},
			},
		})
		const subpath = await buildKodyAppClientBundle({
			sourceFiles: {
				...sourceFiles,
				'package.json': subpathPackageJson,
				'src/client.ts': [
					"import { useState } from 'preact/hooks'",
					'export const state = useState',
				].join('\n'),
			},
			entryPoint: 'src/client.ts',
		})
		expect(subpath.modules[subpath.mainModule]).toMatch(
			/from\s+"preact\/hooks"/,
		)
		await expect(
			buildKodyAppClientBundle({
				sourceFiles: {
					...sourceFiles,
					'package.json': subpathPackageJson,
					'src/client.ts': [
						"import render from 'preact-render-to-string'",
						'export const html = render',
					].join('\n'),
				},
				entryPoint: 'src/client.ts',
			}),
		).rejects.toThrow(
			/unresolved bare package imports after bundling \("preact-render-to-string"\)/,
		)
	},
)
