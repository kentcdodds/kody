import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { packageAppRemixSubpaths } from '#worker/package-runtime/package-app-remix-subpaths.ts'
import {
	ensureWorkerBundlerModules,
	leftoverSrcGeneratedBundlerNames,
	workerBundlerGeneratedDir,
	workerBundlerWranglerDir,
} from './build-worker-bundler-modules.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const leftoverSrcGeneratedDir = path.join(
	repoRoot,
	'packages/worker/src/generated',
)

async function pathExists(filePath: string) {
	try {
		await stat(filePath)
		return true
	} catch {
		return false
	}
}

test('ensureWorkerBundlerModules writes bundler artifacts outside the src watch root', async () => {
	await ensureWorkerBundlerModules()

	for (const name of [
		'worker-bundler.mjs',
		'worker-bundler-typescript.mjs',
		'oauth-provider.mjs',
		'package-app-remix.mjs',
		'esbuild.wasm',
		'worker-bundler.stamp.json',
	] as const) {
		expect(await pathExists(path.join(workerBundlerGeneratedDir, name))).toBe(
			true,
		)
	}
	for (const name of [
		'worker-bundler.mjs',
		'worker-bundler-typescript.mjs',
		'oauth-provider.mjs',
		'package-app-remix.mjs',
		'esbuild.wasm',
	] as const) {
		expect(await pathExists(path.join(workerBundlerWranglerDir, name))).toBe(
			true,
		)
	}

	const generatedWasm = await readFile(
		path.join(workerBundlerGeneratedDir, 'esbuild.wasm'),
	)
	const wranglerWasm = await readFile(
		path.join(workerBundlerWranglerDir, 'esbuild.wasm'),
	)
	expect(generatedWasm.equals(wranglerWasm)).toBe(true)
})

test('ensureWorkerBundlerModules vendors every allowlisted remix subpath as one code-split file set', async () => {
	await ensureWorkerBundlerModules()
	const remixModule = (await import(
		path.join(workerBundlerGeneratedDir, 'package-app-remix.mjs')
	)) as { remixVersion: string; files: Record<string, string> }
	const installedRemix = JSON.parse(
		await readFile(
			path.join(repoRoot, 'node_modules/remix/package.json'),
			'utf8',
		),
	) as { version: string }
	expect(remixModule.remixVersion).toBe(installedRemix.version)

	const vendoredPackage = JSON.parse(
		remixModule.files['package.json'] ?? '',
	) as {
		name: string
		exports: Record<string, string>
	}
	expect(vendoredPackage.name).toBe('remix')
	for (const subpath of packageAppRemixSubpaths) {
		const target = vendoredPackage.exports[`./${subpath}`]
		expect({ subpath, target }).toEqual({
			subpath,
			target: `./dist/${subpath}.js`,
		})
		expect(typeof remixModule.files[`dist/${subpath}.js`]).toBe('string')
	}
	// Code splitting: `remix/ui` and `remix/ui/server` must share one runtime
	// instance, so both entries import a shared chunk instead of inlining it.
	expect(remixModule.files['dist/ui.js']).toMatch(/from"\.\/chunks\//)
	expect(remixModule.files['dist/ui/server.js']).toMatch(/from"\.\.\/chunks\//)
	// Only nodejs_compat builtins may stay external: everything else the
	// package-app isolate cannot resolve would fail at load time.
	const externalSpecifiers = new Set<string>()
	for (const source of Object.values(remixModule.files)) {
		for (const match of source.matchAll(
			/(?:from|import)\s*"((?:node|cloudflare):[^"]+)"/g,
		)) {
			externalSpecifiers.add(match[1] ?? '')
		}
	}
	expect([...externalSpecifiers].sort()).toEqual([
		'node:async_hooks',
		'node:zlib',
	])
})

test('ensureWorkerBundlerModules removes leftover src/generated bundler artifacts', async () => {
	await ensureWorkerBundlerModules()
	const leftoverWasm = path.join(leftoverSrcGeneratedDir, 'esbuild.wasm')
	await writeFile(leftoverWasm, 'leftover-wasm')
	for (const name of leftoverSrcGeneratedBundlerNames) {
		if (name === 'esbuild.wasm') continue
		await writeFile(path.join(leftoverSrcGeneratedDir, name), 'leftover')
	}

	await ensureWorkerBundlerModules()

	for (const name of leftoverSrcGeneratedBundlerNames) {
		expect(await pathExists(path.join(leftoverSrcGeneratedDir, name))).toBe(
			false,
		)
	}
	expect(
		await pathExists(path.join(leftoverSrcGeneratedDir, 'guide-catalog.mjs')),
	).toBe(true)
})
