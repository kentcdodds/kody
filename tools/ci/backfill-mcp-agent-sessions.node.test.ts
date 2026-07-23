import { expect, test, vi } from 'vitest'
import { runMcpAgentSessionBackfill } from './backfill-mcp-agent-sessions.ts'

test('MCP Agent backfill paginates objects and is dry-run first', async () => {
	const fetcher = vi.fn(async (input: string | URL | Request) => {
		const url = String(input)
		if (
			url.includes('/durable_objects/namespaces?') === false &&
			url.endsWith('/durable_objects/namespaces')
		) {
			return Response.json({
				success: true,
				result: [{ id: 'namespace-1', class: 'MCP', script: 'kody' }],
				result_info: {},
			})
		}
		if (url.includes('/objects?limit=100&cursor=next')) {
			return Response.json({
				success: true,
				result: [{ id: 'do-2', hasStoredData: true }],
				result_info: {},
			})
		}
		if (url.includes('/objects?limit=100')) {
			return Response.json({
				success: true,
				result: [
					{ id: 'do-1', hasStoredData: true },
					{ id: 'empty', hasStoredData: false },
				],
				result_info: { cursor: 'next' },
			})
		}
		if (url.endsWith('/__maintenance/backfill-mcp-agent-sessions')) {
			return Response.json({
				ok: true,
				rows: [{ doId: 'do-1', action: 'would_register' }],
				failures: [],
			})
		}
		throw new Error(`Unexpected request: ${url}`)
	}) as unknown as typeof fetch
	const result = await runMcpAgentSessionBackfill({
		accountId: 'account',
		apiToken: 'token',
		maintenanceSecret: 'secret',
		origin: 'https://example.com',
		workerScript: 'kody',
		execute: false,
		apiBaseUrl: 'https://api.example.test',
		fetcher,
	})
	expect(result).toMatchObject({
		dryRun: true,
		pages: 2,
		listedWithStoredData: 2,
		failures: [],
	})
	expect(
		fetcher.mock.calls.some(([url]) =>
			String(url).endsWith(
				'/__maintenance/backfill-mcp-agent-sessions/complete',
			),
		),
	).toBe(false)
})
