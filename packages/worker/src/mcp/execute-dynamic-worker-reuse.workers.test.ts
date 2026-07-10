import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

/**
 * Regression coverage for the production "RPC stub used after being
 * disposed" failures (community_publish / community_search / repo publish
 * capabilities intermittently failing on repeated calls).
 *
 * Execute uses stable dynamic-worker ids when `APP_COMMIT_SHA` is set, so two
 * executes with identical code reuse one sandbox isolate — and the isolate's
 * ES module cache survives between them. The `kody:runtime` virtual module
 * used to freeze the first run's `kody` capability proxy into module scope;
 * that proxy closes over the first `evaluate()` call's RPC ToolDispatcher
 * stubs, which workerd implicitly disposes when that call returns. Every
 * later execute with the same code (including from a brand-new conversation)
 * then called capabilities through disposed stubs.
 *
 * `APP_COMMIT_SHA` is unset in local dev and tests, which is why this only
 * reproduced in deployed environments before this suite pinned it.
 */

const reuseEnv = {
	...env,
	APP_COMMIT_SHA: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
} as Env

function createCaller() {
	return createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-reuse-test',
			email: 'reuse@example.com',
			displayName: 'Reuse Test',
		},
	})
}

test(
	'sequential executes with identical code reuse the dynamic worker without stale dispatcher stubs',
	{ timeout: 60_000 },
	async () => {
		// The worker bundler emits an incidental experimental warning.
		consoleWarn.mockImplementation(() => {})
		const bundle = await buildKodyModuleBundle({
			env: reuseEnv,
			baseUrl: 'https://kody.dev',
			userId: 'user-reuse-test',
			sourceFiles: {
				'entry.ts': [
					"import { kody } from 'kody:runtime'",
					'export default async function main() {',
					"\treturn await kody.ping_capability({ query: 'slack' })",
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})

		const runOnce = async (label: string) =>
			await runBundledModuleWithRegistry(
				reuseEnv,
				// A fresh caller context per call models fresh MCP tool calls —
				// including calls issued with brand-new conversation ids, which
				// still hashed to the same cached dynamic worker in production.
				createCaller(),
				{
					mainModule: bundle.mainModule,
					modules: bundle.modules,
				},
				undefined,
				{
					skipCapabilityRegistry: true,
					additionalTools: {
						ping_capability: async (args: unknown) => ({
							ok: true,
							label,
							args,
						}),
					},
				},
			)

		const first = await runOnce('first')
		expect(first.error).toBeUndefined()
		expect(first.result).toEqual({
			ok: true,
			label: 'first',
			args: { query: 'slack' },
		})

		// Before the kody:runtime late-binding fix this failed with
		// "RPC stub used after being disposed.": the reused isolate's cached
		// runtime module still pointed at the first run's dispatcher stubs.
		const second = await runOnce('second')
		expect(second.error).toBeUndefined()
		expect(second.result).toEqual({
			ok: true,
			label: 'second',
			args: { query: 'slack' },
		})

		const third = await runOnce('third')
		expect(third.error).toBeUndefined()
		expect(third.result).toEqual({
			ok: true,
			label: 'third',
			args: { query: 'slack' },
		})
	},
)
