import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

type StartupBundleDefinition = {
	name: string
	packageDir: string
	entryFile: string
	maxEntryBytes: number
	forbiddenSources: ReadonlyArray<string>
}

const sharedDeferredGuideSources = [
	'/packages/worker/src/guides/catalog.ts',
	'/packages/worker/src/guides/parse-frontmatter.ts',
	'/docs/guides/',
] as const

const startupBundles: ReadonlyArray<StartupBundleDefinition> = [
	{
		name: 'origin',
		packageDir: 'packages/worker',
		entryFile: 'production-worker.js',
		maxEntryBytes: 7_750_000,
		forbiddenSources: ['/packages/worker/src/index.ts'],
	},
	{
		name: 'platform',
		packageDir: 'packages/platform-worker',
		entryFile: 'platform-worker.js',
		maxEntryBytes: 4_975_000,
		forbiddenSources: sharedDeferredGuideSources,
	},
	{
		name: 'runtime',
		packageDir: 'packages/runtime-worker',
		entryFile: 'runtime-worker.js',
		maxEntryBytes: 3_620_000,
		forbiddenSources: [
			...sharedDeferredGuideSources,
			'/packages/worker/src/repo/repo-session-do.ts',
		],
	},
]

function normalizeSourcePath(source: string) {
	return source.replaceAll('\\', '/')
}

async function inspectStartupBundle(
	definition: StartupBundleDefinition,
	outputRoot: string,
	wranglerBinary: string,
) {
	const outputDir = path.join(outputRoot, definition.name)
	const cwd = path.join(repoRoot, definition.packageDir)
	await execFileAsync(
		wranglerBinary,
		[
			'deploy',
			'--dry-run',
			'--outdir',
			outputDir,
			'--config',
			'wrangler.jsonc',
			'--env',
			'production',
		],
		{
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		},
	)

	const entryPath = path.join(outputDir, definition.entryFile)
	const sourceMapPath = `${entryPath}.map`
	const [{ size }, sourceMapText] = await Promise.all([
		stat(entryPath),
		readFile(sourceMapPath, 'utf8'),
	])
	const sourceMap = JSON.parse(sourceMapText) as { sources?: unknown }
	if (
		!Array.isArray(sourceMap.sources) ||
		!sourceMap.sources.every((source) => typeof source === 'string')
	) {
		throw new Error(
			`${definition.name} startup bundle emitted a malformed source map.`,
		)
	}
	const sources = sourceMap.sources.map(normalizeSourcePath)
	const violations = definition.forbiddenSources.filter((forbiddenSource) =>
		sources.some((source) => source.includes(forbiddenSource)),
	)
	if (violations.length > 0) {
		throw new Error(
			`${definition.name} startup bundle includes deferred-only source(s): ${violations.join(', ')}`,
		)
	}
	if (size > definition.maxEntryBytes) {
		throw new Error(
			`${definition.name} startup entry is ${String(size)} bytes, exceeding its ${String(definition.maxEntryBytes)}-byte reviewed budget.`,
		)
	}

	return {
		name: definition.name,
		size,
		maxEntryBytes: definition.maxEntryBytes,
	}
}

/**
 * Builds the three production entry modules and enforces deterministic
 * startup proxies: reviewed main-module size budgets and import-graph
 * boundaries for code that must stay deferred. Cloudflare's measured startup
 * CPU varies by validation host, so this gate deliberately avoids a flaky
 * wall-clock threshold.
 */
export async function checkWorkerStartupBundles() {
	await Promise.all([ensureWorkerBundlerModules(), ensureGuideCatalogModules()])
	const outputRoot = await mkdtemp(path.join(tmpdir(), 'kody-startup-bundles-'))
	const wranglerBinary = resolveLocalBinary('wrangler')
	try {
		const results = await Promise.all(
			startupBundles.map((definition) =>
				inspectStartupBundle(definition, outputRoot, wranglerBinary),
			),
		)
		for (const result of results) {
			console.log(
				`${result.name} startup entry: ${String(result.size)} / ${String(result.maxEntryBytes)} bytes`,
			)
		}
	} finally {
		await rm(outputRoot, { recursive: true, force: true })
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await checkWorkerStartupBundles()
}
