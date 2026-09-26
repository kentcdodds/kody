import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

const productionExportAllowlist = ['JobsHost', 'KodyFetchGateway'] as const

test('production-worker exports only the slim origin allowlist (ADR 0034)', async () => {
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
})
