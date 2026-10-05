import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseJsonc } from './resource-utils.ts'

const workerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
	'packages/jobs-worker/wrangler.jsonc',
] as const

test('origin and secondary workers do not bind package invoke telemetry', async () => {
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
				(entry) =>
					entry.binding === 'PACKAGE_INVOKE_SPECIFIER_EVENTS' ||
					entry.dataset?.includes('package_invoke_specifier'),
			)
			expect(binding, `${configPath} env.${envName}`).toBeUndefined()
		}
	}
})
