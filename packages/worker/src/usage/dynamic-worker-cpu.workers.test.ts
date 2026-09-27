import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

test(
	'Worker Loader runs attach the usage tail and still return results',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = `cpu-${crypto.randomUUID()}`
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					'export default async function main() {',
					'\tlet total = 0',
					'\tfor (let index = 0; index < 2_000_000; index += 1) total += index % 7',
					'\treturn total',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		// Tails attach only where Analytics Engine is bound.
		const usageEnv = {
			...env,
			USAGE_EVENTS: { writeDataPoint() {} },
		} as unknown as Env
		const result = await runBundledModuleWithRegistry(
			usageEnv,
			createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: { userId, email: 'cpu@example.com', displayName: 'CPU' },
			}),
			{ mainModule: bundle.mainModule, modules: bundle.modules },
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toBeUndefined()
		expect(typeof result.result).toBe('number')

		// Loader accepted `tails` and still returned the run's result. Open-source
		// workerd reports `cpuTime` 0, so recording is proven by unit tests and
		// verified on deployed Workers.
	},
)
