import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseJsonc } from './resource-utils.ts'

const searchWorkerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
] as const

test('origin and platform bind MCP search telemetry in production and preview', async () => {
	for (const configPath of searchWorkerConfigPaths) {
		const config = parseJsonc<{
			env?: Record<
				string,
				{
					analytics_engine_datasets?: Array<{
						binding?: string
						dataset?: string
					}>
				}
			>
		}>(await readFile(configPath, 'utf8'))
		for (const envName of ['production', 'preview'] as const) {
			const binding = config.env?.[envName]?.analytics_engine_datasets?.find(
				(entry) => entry.binding === 'MCP_SEARCH_EVENTS',
			)
			const expectedDataset =
				envName === 'production'
					? 'kody_mcp_search_events'
					: 'kody_mcp_search_events_preview'
			expect(binding, `${configPath} env.${envName}`).toEqual({
				binding: 'MCP_SEARCH_EVENTS',
				dataset: expectedDataset,
			})
		}
	}
})
