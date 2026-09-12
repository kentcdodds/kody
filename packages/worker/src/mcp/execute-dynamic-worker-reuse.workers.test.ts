import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Regression coverage for the production "RPC stub used after being
 * disposed" failures (communityPublish / communitySearch / repo publish
 * capabilities intermittently failing on repeated calls).
 *
 * Execute uses a stable dynamic-worker id for a hashable module graph, so two
 * executes with identical code reuse one sandbox isolate — and the isolate's
 * ES module cache survives between them. The `kody:runtime` virtual module
 * used to freeze the first run's `kody` capability proxy into module scope;
 * that proxy closes over the first `evaluate()` call's RPC ToolDispatcher
 * stubs, which workerd implicitly disposes when that call returns. Every
 * later execute with the same code (including from a brand-new conversation)
 * then called capabilities through disposed stubs.
 *
 * Reuse no longer depends on `APP_COMMIT_SHA`. This suite still pins one so
 * the fixture matches deployed env shape; the regression is the stale
 * dispatcher stubs on a reused isolate.
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
		// The bundler and registry runtime emit known incidental warnings; only
		// those are swallowed, anything else still fails the test.
		silenceIncidentalRuntimeWarnings()
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

test(
	'sequential executes with the same code and different params reuse the isolate and deliver params',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyModuleBundle({
			env: reuseEnv,
			baseUrl: 'https://kody.dev',
			userId: 'user-reuse-test',
			sourceFiles: {
				'entry.ts': [
					"import { kody, packageContext, packageSecrets } from 'kody:runtime'",
					'export default async function main(params) {',
					'\treturn {',
					'\t\tparams,',
					'\t\tpackageId: packageContext?.packageId ?? null,',
					'\t\tsecretsBound: "get" in packageSecrets,',
					'\t\tping: await kody.ping_capability({ query: params.room }),',
					'\t}',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})

		const runOnce = async (
			label: string,
			params: { room: string },
			packageContext?: { packageId: string; kodyId: string },
		) =>
			await runBundledModuleWithRegistry(
				reuseEnv,
				createCaller(),
				{
					mainModule: bundle.mainModule,
					modules: bundle.modules,
				},
				params,
				{
					skipCapabilityRegistry: true,
					...(packageContext ? { packageContext } : {}),
					additionalTools: {
						ping_capability: async (args: unknown) => ({
							ok: true,
							label,
							args,
						}),
					},
				},
			)

		const first = await runOnce('first', { room: 'office' })
		expect(first.error).toBeUndefined()
		expect(first.result).toEqual({
			params: { room: 'office' },
			packageId: null,
			secretsBound: false,
			ping: { ok: true, label: 'first', args: { query: 'office' } },
		})

		const second = await runOnce('second', { room: 'kitchen' })
		expect(second.error).toBeUndefined()
		expect(second.result).toEqual({
			params: { room: 'kitchen' },
			packageId: null,
			secretsBound: false,
			ping: { ok: true, label: 'second', args: { query: 'kitchen' } },
		})

		const third = await runOnce(
			'third',
			{ room: 'office' },
			{ packageId: 'pkg-reuse', kodyId: 'bot-reuse' },
		)
		expect(third.error).toBeUndefined()
		expect(third.result).toEqual({
			params: { room: 'office' },
			packageId: 'pkg-reuse',
			secretsBound: true,
			ping: { ok: true, label: 'third', args: { query: 'office' } },
		})
	},
)

test(
	'module-scope packageContext capture still late-binds across evaluate reuse',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyModuleBundle({
			env: reuseEnv,
			baseUrl: 'https://kody.dev',
			userId: 'user-reuse-test',
			sourceFiles: {
				'entry.ts': [
					"import { packageContext } from 'kody:runtime'",
					'const capturedContext = packageContext',
					'export default async function main() {',
					'\treturn { packageId: capturedContext?.packageId ?? null }',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})

		const runOnce = async (packageContext: {
			packageId: string
			kodyId: string
		}) =>
			await runBundledModuleWithRegistry(
				reuseEnv,
				createCaller(),
				{
					mainModule: bundle.mainModule,
					modules: bundle.modules,
				},
				undefined,
				{
					skipCapabilityRegistry: true,
					packageContext,
				},
			)

		const first = await runOnce({ packageId: 'pkg-a', kodyId: 'bot-a' })
		const second = await runOnce({ packageId: 'pkg-b', kodyId: 'bot-b' })
		expect(first.error).toBeUndefined()
		expect(second.error).toBeUndefined()
		expect(first.result).toEqual({ packageId: 'pkg-a' })
		expect(second.result).toEqual({ packageId: 'pkg-b' })
	},
)

test(
	'mutating packageContext.packageId cannot retarget unstamped packageSecrets',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyModuleBundle({
			env: reuseEnv,
			baseUrl: 'https://kody.dev',
			userId: 'user-reuse-test',
			sourceFiles: {
				'entry.ts': [
					"import { packageContext, packageSecrets } from 'kody:runtime'",
					'export default async function main() {',
					'\tlet mutationError = null',
					'\ttry {',
					"\t\tpackageContext.packageId = 'pkg-attacker'",
					'\t} catch (error) {',
					'\t\tmutationError = error instanceof Error ? error.message : String(error)',
					'\t}',
					'\treturn {',
					'\t\tpackageId: packageContext?.packageId ?? null,',
					'\t\tsecretsBound: "get" in packageSecrets,',
					'\t\tmutationError,',
					'\t}',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})

		const result = await runBundledModuleWithRegistry(
			reuseEnv,
			createCaller(),
			{
				mainModule: bundle.mainModule,
				modules: bundle.modules,
			},
			undefined,
			{
				skipCapabilityRegistry: true,
				packageContext: { packageId: 'pkg-trusted', kodyId: 'bot-trusted' },
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			packageId: 'pkg-trusted',
			secretsBound: true,
			mutationError: expect.stringMatching(
				/trap returned falsish|cannot assign|read.only|frozen/i,
			),
		})
	},
)
