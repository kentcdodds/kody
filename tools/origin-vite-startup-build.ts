import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './ci/resource-utils.ts'
import { resolveLocalBinary } from './node-runtime.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export const originProductionEntryPath = './src/production-worker.ts'

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
 * pipeline production deploy uses. Writes into `outputRoot` so validate's
 * concurrent `vite build` / e2e jobs do not clobber repo `dist/`.
 */
export async function buildOriginProductionViteBundle(
	outputRoot: string,
): Promise<OriginViteStartupBuild> {
	const outDir = path.join(outputRoot, 'dist')
	const configPath = path.join(outputRoot, 'wrangler-origin-startup.json')
	await mkdir(outputRoot, { recursive: true })
	const committedConfig = parseJsonc<Record<string, unknown>>(
		await readFile(
			path.join(repoRoot, 'packages/worker/wrangler.jsonc'),
			'utf8',
		),
	)
	await writeFile(
		configPath,
		`${JSON.stringify({
			...committedConfig,
			main: originProductionEntryPath,
		})}\n`,
	)
	await execFileAsync(resolveLocalBinary('vite'), ['build'], {
		cwd: repoRoot,
		env: {
			...process.env,
			KODY_WRANGLER_CONFIG: configPath,
			KODY_VITE_OUTDIR: outDir,
		},
		maxBuffer: 20 * 1024 * 1024,
	})
	const ssrDir = path.join(outDir, 'ssr')
	return {
		outDir,
		entryPath: path.join(ssrDir, 'index.js'),
		sourceMapPath: path.join(ssrDir, 'index.js.map'),
		assetsDir: path.join(ssrDir, 'assets'),
		wranglerConfigPath: path.join(ssrDir, 'wrangler.json'),
	}
}
