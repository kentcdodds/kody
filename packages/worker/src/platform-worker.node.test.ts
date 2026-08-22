import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

test('platform worker exports KodyFetchGateway for MCP execute loopback', async () => {
	const source = await readFile(
		new URL('./platform-worker.ts', import.meta.url),
		'utf8',
	)
	const exportBlock = source.match(/export \{([^}]+)\}/)?.[1] ?? ''
	const names = exportBlock
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean)
	expect(names).toContain('KodyFetchGateway')
	expect(source).toMatch(
		/import \{ KodyFetchGateway \} from '#mcp\/fetch-gateway\.ts'/,
	)
})
