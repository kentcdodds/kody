import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './ci/resource-utils.ts'
import { resolveLocalBinary } from './node-runtime.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workerDir = path.join(repoRoot, 'packages/worker')

export const originProductionEntryPath = './src/production-worker.ts'
export const originStartupWranglerConfigPath = path.join(
	workerDir,
	'wrangler-origin-startup.generated.json',
)

export const originViteDeferredAssetPatterns = {
	guideCatalog: /^guide-catalog-[^/]+\.js$/,
	workerBundler: /^worker-bundler-[^/]+\.js$/,
	oauthProvider: /^oauth-provider-[^/]+\.js$/,
	esbuildWasm: /^esbuild-[^/]+\.wasm$/,
} as const

export type OriginViteDeferredAssets = {
	guideCatalog: Array<string>
	workerBundler: Array<string>
	oauthProvider: Array<string>
	esbuildWasm: Array<string>
}

export function findOriginViteDeferredAssets(
	assetNames: ReadonlyArray<string>,
): OriginViteDeferredAssets {
	return {
		guideCatalog: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.guideCatalog.test(name),
		),
		workerBundler: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.workerBundler.test(name),
		),
		oauthProvider: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.oauthProvider.test(name),
		),
		esbuildWasm: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.esbuildWasm.test(name),
		),
	}
}

export type OriginViteStartupBuild = {
	outDir: string
	entryPath: string
	sourceMapPath: string
	assetsDir: string
	wranglerConfigPath: string
}

/**
 * Builds the slim origin production entry with the same Vite + Pitlane
 * pipeline production deploy uses. The Cloudflare Vite plugin always writes
 * `dist/ssr` at the repo root; this copies that tree into `outputRoot` so the
 * startup inspectors can keep a stable snapshot.
 */
export async function buildOriginProductionViteBundle(
	outputRoot: string,
): Promise<OriginViteStartupBuild> {
	await mkdir(outputRoot, { recursive: true })
	const committedConfig = parseJsonc<Record<string, unknown>>(
		await readFile(path.join(workerDir, 'wrangler.jsonc'), 'utf8'),
	)
	await writeFile(
		originStartupWranglerConfigPath,
		`${JSON.stringify({
			...committedConfig,
			main: originProductionEntryPath,
		})}\n`,
	)
	try {
		await execFileAsync(resolveLocalBinary('vite'), ['build'], {
			cwd: repoRoot,
			env: {
				...process.env,
				KODY_WRANGLER_CONFIG: originStartupWranglerConfigPath,
			},
			maxBuffer: 20 * 1024 * 1024,
		})
	} finally {
		await rm(originStartupWranglerConfigPath, { force: true })
	}

	const repoSsrDir = path.join(repoRoot, 'dist', 'ssr')
	const ssrDir = path.join(outputRoot, 'ssr')
	await cp(repoSsrDir, ssrDir, { recursive: true })
	const wranglerConfigPath = path.join(ssrDir, 'wrangler.json')
	const builtWrangler = JSON.parse(
		await readFile(wranglerConfigPath, 'utf8'),
	) as { main?: string }
	const entryFile = builtWrangler.main ?? 'index.js'
	const entryPath = path.join(ssrDir, entryFile)
	return {
		outDir: outputRoot,
		entryPath,
		sourceMapPath: `${entryPath}.map`,
		assetsDir: path.join(ssrDir, 'assets'),
		wranglerConfigPath,
	}
}
