import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseJsonc } from './resource-utils.ts'

const workerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
	'packages/jobs-worker/wrangler.jsonc',
] as const

test('origin and secondary workers bind package invoke telemetry in production and preview', async () => {
	for (const configPath of workerConfigPaths) {
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
				(entry) => entry.binding === 'PACKAGE_INVOKE_SPECIFIER_EVENTS',
			)
			expect(binding, `${configPath} env.${envName}`).toEqual({
				binding: 'PACKAGE_INVOKE_SPECIFIER_EVENTS',
				dataset:
					envName === 'production'
						? 'kody_package_invoke_specifier_events'
						: 'kody_package_invoke_specifier_events_preview',
			})
		}
	}
})
