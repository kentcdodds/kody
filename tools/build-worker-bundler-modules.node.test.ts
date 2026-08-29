import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	ensureWorkerBundlerModules,
	leftoverSrcGeneratedBundlerNames,
	removeLeftoverSrcGeneratedBundlerArtifacts,
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
		'esbuild-wasm.mjs',
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
		'esbuild-wasm.mjs',
	] as const) {
		expect(await pathExists(path.join(workerBundlerWranglerDir, name))).toBe(
			true,
		)
	}
	expect(
		await pathExists(path.join(workerBundlerWranglerDir, 'esbuild.wasm')),
	).toBe(false)

	const bundlerSource = await readFile(
		path.join(workerBundlerWranglerDir, 'worker-bundler.mjs'),
		'utf8',
	)
	expect(bundlerSource.includes('import("./esbuild-wasm.mjs")')).toBe(true)
	expect(bundlerSource.includes('import("./esbuild.wasm")')).toBe(false)
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

test('removeLeftoverSrcGeneratedBundlerArtifacts is a no-op when leftovers are already gone', async () => {
	await removeLeftoverSrcGeneratedBundlerArtifacts()
	await removeLeftoverSrcGeneratedBundlerArtifacts()
	await rm(path.join(leftoverSrcGeneratedDir, 'esbuild.wasm'), { force: true })
	expect(
		await pathExists(path.join(leftoverSrcGeneratedDir, 'esbuild.wasm')),
	).toBe(false)
})
