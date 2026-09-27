import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from './test-schema.ts'

test(
	'Worker Loader runs attach the usage tail and still return results',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureUsageRollupsTestSchema(env.APP_DB)
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
		const result = await runBundledModuleWithRegistry(
			env,
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

		// The tail runs after the response. Open-source workerd delivers the
		// trace event but reports `cpuTime` 0; deployed Workers report the
		// measured CPU. Either way the value is the platform's, never wall
		// clock.
		await vi.waitFor(
			async () => {
				const row = await env.APP_DB.prepare(
					`SELECT event_count, total_cpu_ms FROM usage_rollups
					 WHERE user_id = ? AND metric = 'dynamic_worker_cpu'`,
				)
					.bind(userId)
					.first<{ event_count: number; total_cpu_ms: number }>()
				expect(row?.event_count).toBeGreaterThanOrEqual(1)
				expect(row?.total_cpu_ms).toBeGreaterThanOrEqual(0)
			},
			{ timeout: 10_000, interval: 100 },
		)
	},
)
