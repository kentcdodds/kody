import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseJsonc } from './resource-utils.ts'

const executeWorkerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
] as const

test('origin and platform bind execute interpretable telemetry in production and preview', async () => {
	for (const configPath of executeWorkerConfigPaths) {
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
				(entry) => entry.binding === 'EXECUTE_INTERPRETABLE_EVENTS',
			)
			expect(binding?.binding, `${configPath} env.${envName}`).toBe(
				'EXECUTE_INTERPRETABLE_EVENTS',
			)
			expect(
				binding?.dataset?.length ?? 0,
				`${configPath} env.${envName} dataset`,
			).toBeGreaterThan(0)
		}
	}
})
