import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Regression coverage for sandbox console capture: user modules are loaded via
 * `import("./main.js")`, so a lexical `const console` in `evaluate()` cannot
 * shadow the free `console` binding those modules resolve. Capture must assign
 * onto `globalThis` and restore in `finally` so reused dynamic workers do not
 * write into a previous run's `__logs`. Fetch uses a once-per-isolate patch
 * plus AsyncLocalStorage instead of restore-in-finally.
 */

const reuseEnv = {
	...env,
	APP_COMMIT_SHA: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
} as Env

function createCaller(userId: string) {
	return createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId,
			email: `${userId}@example.com`,
			displayName: 'Console Capture',
		},
	})
}

async function bundleLines(runEnv: Env, userId: string, lines: Array<string>) {
	return await buildKodyModuleBundle({
		env: runEnv,
		baseUrl: 'https://kody.dev',
		userId,
		sourceFiles: { 'entry.ts': lines.join('\n') },
		entryPoint: 'entry.ts',
	})
}

async function runBundle(
	runEnv: Env,
	userId: string,
	bundle: Awaited<ReturnType<typeof bundleLines>>,
	additionalTools?: Record<string, () => Promise<unknown>>,
) {
	return await runBundledModuleWithRegistry(
		runEnv,
		createCaller(userId),
		bundle,
		undefined,
		{
			skipCapabilityRegistry: true,
			...(additionalTools ? { additionalTools } : {}),
		},
	)
}

test(
	'console capture contract: levels on success, capture through throw, and unshimmed methods',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-console-capture-contract'
		const cases = [
			{
				label: 'log/warn/error levels are captured with the correct prefix',
				lines: [
					"\tconsole.log('alpha')",
					"\tconsole.log('beta')",
					"\tconsole.warn('heads up')",
					"\tconsole.error('boom line')",
					"\treturn 'ok'",
				],
				expected: {
					error: undefined,
					result: 'ok',
					logs: ['alpha', 'beta', '[warn] heads up', '[error] boom line'],
				},
			},
			{
				label: 'logs emitted before a throw are still captured',
				lines: [
					"\tconsole.log('before throw')",
					"\tconsole.warn('about to fail')",
					"\tthrow new Error('sandbox boom')",
				],
				expected: {
					error: 'sandbox boom',
					result: undefined,
					logs: ['before throw', '[warn] about to fail'],
				},
			},
			{
				// Unshimmed console methods (table, dir, count, time, …) do not
				// throw; only console.log output is included in the captured logs.
				label: 'unshimmed console methods',
				lines: [
					"\tconsole.log('before table')",
					'\tconsole.table({ ok: true })',
					'\tconsole.dir({ ok: true })',
					"\tconsole.count('label')",
					"\tconsole.countReset('label')",
					"\tconsole.time('t')",
					"\tconsole.timeEnd('t')",
					"\treturn 'ok'",
				],
				expected: { error: undefined, result: 'ok', logs: ['before table'] },
			},
		]
		for (const { label, lines, expected } of cases) {
			const bundle = await bundleLines(env, userId, [
				'export default async function main() {',
				...lines,
				'}',
			])
			const run = await runBundle(env, userId, bundle)
			expect({
				label,
				error: run.error,
				result: run.result,
				logs: run.logs,
			}).toEqual({ label, ...expected })
		}
	},
)

test(
	'reused dynamic workers capture only the current run logs',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-console-capture-reuse'
		// Identical code + modules + acting user => same dynamic-worker id.
		// Per-run labels arrive through RPC dispatchers, not baked code.
		const bundle = await bundleLines(reuseEnv, userId, [
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			'\tconst { label } = await kody.ping_capability({})',
			'\tconsole.log(label)',
			'\tconsole.log(`${label}-tail`)',
			'\treturn label',
			'}',
		])
		for (const label of ['first-run', 'second-run']) {
			const run = await runBundle(reuseEnv, userId, bundle, {
				ping_capability: async () => ({ label }),
			})
			expect(run.error).toBeUndefined()
			expect(run.logs).toEqual([label, `${label}-tail`])
		}
	},
)
