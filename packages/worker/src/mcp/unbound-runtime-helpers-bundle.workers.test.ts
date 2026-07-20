import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Regression coverage for the unbound-helper hint against a REAL
 * `buildKodyModuleBundle` bundle rather than hand-written modules: the
 * bundler inlines the virtual `kody:runtime` module into the entry module,
 * so no `kody:runtime` import statements survive and helpers appear as
 * `var storage = __kodyOptionalRuntimeObjectExport("storage", void 0)`
 * declarations. The detector must match that inlined shape, or the hint
 * only ever fires in synthetic tests (as shipped in the first iteration).
 */
test(
	'guard-less unbound storage access in a real bundle gets the bound-context hint',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-unbound-repro',
				email: 'repro@example.com',
				displayName: 'Repro',
			},
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: 'user-unbound-repro',
			sourceFiles: {
				'entry.ts': [
					"import { storage } from 'kody:runtime'",
					'export default async function main() {',
					"\tconst result = await storage.sql('select 1')",
					'\treturn result.rows',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toContain(
			"Cannot read properties of undefined (reading 'sql')",
		)
		expect(result.error).toContain(
			'The optional kody:runtime export "storage" is not bound in this execution context',
		)
	},
)
