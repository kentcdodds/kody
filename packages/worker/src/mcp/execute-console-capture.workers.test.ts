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
 * onto `globalThis` (same pattern as the fetch shim) and restore in `finally`
 * so reused dynamic workers do not write into a previous run's `__logs`.
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

async function buildEntryBundle(input: {
	env: Env
	userId: string
	source: string
}) {
	return await buildKodyModuleBundle({
		env: input.env,
		baseUrl: 'https://kody.dev',
		userId: input.userId,
		sourceFiles: {
			'entry.ts': input.source,
		},
		entryPoint: 'entry.ts',
	})
}

test(
	'console.log/warn/error from a user module are captured with existing prefixes',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-console-capture-levels'
		const bundle = await buildEntryBundle({
			env,
			userId,
			source: [
				'export default async function main() {',
				"\tconsole.log('alpha')",
				"\tconsole.log('beta')",
				"\tconsole.warn('heads up')",
				"\tconsole.error('boom line')",
				"\treturn 'ok'",
				'}',
			].join('\n'),
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCaller(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toBe('ok')
		expect(result.logs).toEqual([
			'alpha',
			'beta',
			'[warn] heads up',
			'[error] boom line',
		])
	},
)

test(
	'console logs are captured when user code throws',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-console-capture-throw'
		const bundle = await buildEntryBundle({
			env,
			userId,
			source: [
				'export default async function main() {',
				"\tconsole.log('before throw')",
				"\tconsole.warn('about to fail')",
				"\tthrow new Error('sandbox boom')",
				'}',
			].join('\n'),
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCaller(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toBe('sandbox boom')
		expect(result.logs).toEqual(['before throw', '[warn] about to fail'])
	},
)

test(
	'reused dynamic workers capture only the current run logs',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-console-capture-reuse'
		// Identical code + modules => same dynamic-worker id when APP_COMMIT_SHA
		// is set. Per-run labels arrive through RPC dispatchers, not baked code.
		const bundle = await buildEntryBundle({
			env: reuseEnv,
			userId,
			source: [
				"import { kody } from 'kody:runtime'",
				'export default async function main() {',
				'\tconst { label } = await kody.ping_capability({})',
				'\tconsole.log(label)',
				'\tconsole.log(`${label}-tail`)',
				'\treturn label',
				'}',
			].join('\n'),
		})

		const runOnce = async (label: string) =>
			await runBundledModuleWithRegistry(
				reuseEnv,
				createCaller(userId),
				bundle,
				undefined,
				{
					skipCapabilityRegistry: true,
					additionalTools: {
						ping_capability: async () => ({ label }),
					},
				},
			)

		const first = await runOnce('first-run')
		expect(first.error).toBeUndefined()
		expect(first.logs).toEqual(['first-run', 'first-run-tail'])

		const second = await runOnce('second-run')
		expect(second.error).toBeUndefined()
		expect(second.logs).toEqual(['second-run', 'second-run-tail'])
		expect(second.logs).not.toEqual(
			expect.arrayContaining(['first-run', 'first-run-tail']),
		)
	},
)

test(
	'unshimmed console methods do not throw for user modules',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = 'user-console-capture-unshimmed'
		const bundle = await buildEntryBundle({
			env,
			userId,
			source: [
				'export default async function main() {',
				"\tconsole.log('before table')",
				'\tconsole.table({ ok: true })',
				'\tconsole.dir({ ok: true })',
				"\tconsole.count('label')",
				"\tconsole.countReset('label')",
				"\tconsole.time('t')",
				"\tconsole.timeEnd('t')",
				"\treturn 'ok'",
				'}',
			].join('\n'),
		})
		const result = await runBundledModuleWithRegistry(
			env,
			createCaller(userId),
			bundle,
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toBe('ok')
		expect(result.logs).toEqual(['before table'])
	},
)
