import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

const productionExportAllowlist = ['JobsHost', 'KodyFetchGateway'] as const

test('production-worker does not export PackageAppRuntimeBridge (ADR 0034)', async () => {
	const source = await readFile(
		new URL('../production-worker.ts', import.meta.url),
		'utf8',
	)
	const exportBlock = source.match(/export \{([^}]+)\}/)?.[1] ?? ''
	const names = exportBlock
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean)

	expect(names.sort()).toEqual([...productionExportAllowlist].sort())
	expect(names).not.toContain('PackageAppRuntimeBridge')
	expect(source).toMatch(/RUNTIME_WORKER/)
})

test('runtime-worker exports RuntimeWorkerService for the RUNTIME_WORKER entrypoint', async () => {
	const source = await readFile(
		new URL('../runtime-worker.ts', import.meta.url),
		'utf8',
	)
	expect(source).toMatch(/export class RuntimeWorkerService/)
	expect(source).toMatch(/servePackageApp\(/)
	expect(source).toMatch(/PackageAppRuntimeBridge/)
})
