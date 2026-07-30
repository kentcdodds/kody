import { type createMcpCallerContext } from '#mcp/context.ts'
import {
	type PackageInvokeCheckResult,
	type PackageInvokeInput,
	type PackageInvokeTools,
} from '#mcp/run-kody-registry.ts'
import { type RunRecordContext } from '#worker/run-records/types.ts'
import {
	maxPackageRuntimeInvokeDepth,
	type PackageInvocationResponse,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { createAutoPackageInvokeIdempotencyKey } from './idempotency.ts'
import {
	invokePackageExportForExecuteRuntime,
	invokePackageExportForPackageRuntime,
} from './http-invoke.ts'
import { parsePackageInvokeInput } from './input-parsing.ts'
import {
	checkPackageInvokeForRuntime,
	checkPackageInvokeForRuntimeWithPreloads,
	type PackageInvokeCheckPreloads,
} from './invoke-check.ts'

export function createPackageRuntimeInvokeToolsWithToolFactories(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageInvokeTools {
	return createPackageInvokeTools({
		...input,
		callerKind: 'package',
	})
}

export function createExecutePackageInvokeToolsWithToolFactories(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	/** MCP execute conversation id for agent-facing popularity recording. */
	conversationId?: string | null
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageInvokeTools {
	return createPackageInvokeTools({
		...input,
		packageContext: null,
		callerKind: 'execute',
		conversationId: input.conversationId ?? null,
	})
}

function createPackageInvokeTools(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	callerKind: 'package' | 'execute'
	conversationId?: string | null
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageInvokeTools {
	let autoIdempotencySequence = 0
	const requireRuntimeCaller = (operationName: string) => {
		const user = input.callerContext.user
		if (!user?.userId) {
			throw new Error(`${operationName} requires an authenticated user.`)
		}
		if (input.callerKind === 'package' && !input.packageContext) {
			throw new Error(`${operationName} requires a package runtime context.`)
		}
		return { user, packageContext: input.packageContext }
	}
	const invoke = async (
		rawInput: PackageInvokeInput,
		preloads?: PackageInvokeCheckPreloads | null,
	) => {
		const { user, packageContext } = requireRuntimeCaller('packages.invoke')
		const packageInvokeDepth = input.packageInvokeDepth ?? 0
		if (packageInvokeDepth >= maxPackageRuntimeInvokeDepth) {
			throw new Error(
				`packages.invoke exceeded the maximum nested invocation depth (${maxPackageRuntimeInvokeDepth}).`,
			)
		}
		const request = parsePackageInvokeInput(rawInput)
		autoIdempotencySequence += 1
		const idempotencyKey =
			request.idempotencyKey ??
			(await createAutoPackageInvokeIdempotencyKey({
				callerPackageContext: packageContext,
				parentRunRecord: input.parentRunRecord ?? null,
				sequence: autoIdempotencySequence,
				request,
			}))
		const response = packageContext
			? await invokePackageExportForPackageRuntime({
					env: input.env,
					baseUrl: input.baseUrl,
					caller: {
						userId: user.userId,
						email: user.email ?? '',
						displayName: user.displayName ?? '',
						remoteConnectors: input.callerContext.remoteConnectors ?? null,
						packageContext,
					},
					request: {
						packageIdOrKodyId: request.packageIdOrKodyId,
						exportName: request.exportName,
						params: request.params,
						idempotencyKey,
						source: `package:${packageContext.kodyId}`,
						topic: request.topic,
					},
					runtimeInvokeDepth: packageInvokeDepth + 1,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
					preloads: preloads ?? null,
				})
			: await invokePackageExportForExecuteRuntime({
					env: input.env,
					baseUrl: input.baseUrl,
					caller: {
						userId: user.userId,
						email: user.email ?? '',
						displayName: user.displayName ?? '',
						remoteConnectors: input.callerContext.remoteConnectors ?? null,
					},
					request: {
						packageIdOrKodyId: request.packageIdOrKodyId,
						exportName: request.exportName,
						params: request.params,
						idempotencyKey,
						topic: request.topic,
					},
					runtimeInvokeDepth: packageInvokeDepth + 1,
					conversationId: input.conversationId ?? null,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
					preloads: preloads ?? null,
				})
		if (response.status >= 200 && response.status < 400) {
			return response.body['result']
		}
		const errorRecord =
			(response.body['error'] as Record<string, unknown> | undefined) ?? {}
		const code = String(errorRecord['code'] ?? 'package_invocation_failed')
		const message = String(
			errorRecord['message'] ??
				`Package invocation failed with HTTP ${response.status}.`,
		)
		const error = new Error(`[${code}] ${message}`) as Error & {
			code?: string
			status?: number
			response?: PackageInvocationResponse
		}
		error.code = code
		error.status = response.status
		error.response = response
		throw error
	}
	return {
		check: async (rawInput) => {
			const { user } = requireRuntimeCaller('packages.check')
			return await checkPackageInvokeForRuntime({
				env: input.env,
				baseUrl: input.baseUrl,
				operationName: 'packages.check',
				userId: user.userId,
				rawInput,
			})
		},
		invoke,
		invokeChecked: async (rawInput) => {
			const { user } = requireRuntimeCaller('packages.invokeChecked')
			// Skip the export projection (full package source) that a bare
			// `packages.check` surfaces: invokeChecked discards the success
			// contract, and the preloads let the invoke phase reuse the
			// package row, manifest, and bundle artifact loaded here.
			const check = await checkPackageInvokeForRuntimeWithPreloads({
				env: input.env,
				baseUrl: input.baseUrl,
				operationName: 'packages.invokeChecked',
				userId: user.userId,
				rawInput,
				includeExportProjection: false,
			})
			if (!check.result.ok) {
				const error = new Error(
					`packages.invokeChecked check failed: ${check.result.message}`,
				) as Error & {
					check?: PackageInvokeCheckResult
				}
				error.check = check.result
				throw error
			}
			return await invoke(check.result.invoke, check.preloads)
		},
	}
}
