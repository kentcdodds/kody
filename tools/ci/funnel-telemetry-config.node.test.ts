import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseJsonc } from './resource-utils.ts'

const funnelWorkerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
] as const

test('origin, platform, and runtime bind funnel events in production and preview', async () => {
	for (const configPath of funnelWorkerConfigPaths) {
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
				(entry) => entry.binding === 'FUNNEL_EVENTS',
			)
			const expectedDataset =
				envName === 'production'
					? 'kody_funnel_events'
					: 'kody_funnel_events_preview'
			expect(binding, `${configPath} env.${envName}`).toEqual({
				binding: 'FUNNEL_EVENTS',
				dataset: expectedDataset,
			})
		}
	}
})
