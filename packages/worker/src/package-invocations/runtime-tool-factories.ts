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
import {
	invokePackageExportForExecuteRuntime,
	invokePackageExportForPackageRuntime,
} from './http-invoke.ts'
import { parsePackageInvokeInput } from './input-parsing.ts'
import { checkPackageInvokeForRuntimeWithPreloads } from './invoke-check.ts'
import {
	recordPackageInvokeSpecifierForm,
	resolvePackageInvokeTelemetrySurface,
} from './specifier-form-telemetry.ts'

function throwIfPackageInvokeAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return
	const reason = signal.reason
	if (reason instanceof Error) throw reason
	throw new DOMException('The package invocation was aborted.', 'AbortError')
}

export function createPackageRuntimeInvokeToolsWithToolFactories(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	runtimeSurface?: 'app'
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
	runtimeSurface?: 'app'
	callerKind: 'package' | 'execute'
	conversationId?: string | null
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageInvokeTools {
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
	/**
	 * The single dynamic invocation primitive. Always contract-checked first
	 * (the check preloads the package row, manifest, and bundle artifact so
	 * the invoke phase never reloads them), then routed by key presence:
	 * key-less runs the lean/ephemeral path, keyed runs the exactly-once
	 * ledger path.
	 */
	const invoke = async (rawInput: PackageInvokeInput, signal?: AbortSignal) => {
		throwIfPackageInvokeAborted(signal)
		if (
			!rawInput ||
			typeof rawInput !== 'object' ||
			typeof rawInput.specifier !== 'string'
		) {
			throw new Error(
				'Object-only packages.invoke was removed. Use a static import (import fn from "kody:@owner/package/export") when the name is known, or import(specifier) when the name is data.',
			)
		}
		const { user, packageContext } = requireRuntimeCaller('packages.invoke')
		const packageInvokeDepth = input.packageInvokeDepth ?? 0
		if (packageInvokeDepth >= maxPackageRuntimeInvokeDepth) {
			throw new Error(
				`packages.invoke exceeded the maximum nested invocation depth (${maxPackageRuntimeInvokeDepth}).`,
			)
		}
		recordPackageInvokeSpecifierForm(input.env, {
			rawSpecifier: rawInput.specifier,
			surface: resolvePackageInvokeTelemetrySurface(input),
		})
		const request = parsePackageInvokeInput(rawInput)
		const check = await checkPackageInvokeForRuntimeWithPreloads({
			env: input.env,
			baseUrl: input.baseUrl,
			operationName: 'packages.invoke',
			userId: user.userId,
			rawInput,
			callerKind: input.callerKind,
			callingPackageId: packageContext?.packageId ?? null,
		})
		throwIfPackageInvokeAborted(signal)
		if (!check.result.ok || !check.preloads) {
			const message = check.result.ok
				? 'packages.invoke could not preload the package artifact.'
				: `packages.invoke contract check failed: ${check.result.message}`
			const error = new Error(message) as Error & {
				check?: PackageInvokeCheckResult
			}
			error.check = check.result
			throw error
		}
		const response = packageContext
			? await invokePackageExportForPackageRuntime({
					env: input.env,
					baseUrl: input.baseUrl,
					caller: {
						userId: user.userId,
						packageContext,
					},
					request: {
						packageIdOrKodyId: check.preloads.savedPackage.id,
						exportName: request.exportName,
						params: request.params,
						idempotencyKey: request.idempotencyKey,
						source: `package:${packageContext.kodyId}`,
						topic: request.topic,
					},
					runtimeInvokeDepth: packageInvokeDepth + 1,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
					preloads: check.preloads,
					signal,
				})
			: await invokePackageExportForExecuteRuntime({
					env: input.env,
					baseUrl: input.baseUrl,
					caller: {
						userId: user.userId,
					},
					request: {
						packageIdOrKodyId: check.preloads.savedPackage.id,
						exportName: request.exportName,
						params: request.params,
						idempotencyKey: request.idempotencyKey,
						topic: request.topic,
					},
					runtimeInvokeDepth: packageInvokeDepth + 1,
					conversationId: input.conversationId ?? null,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
					preloads: check.preloads,
					signal,
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
	// Unsupported helpers stay out of the host bridge; permanent sandbox
	// teaching stubs reject them without a host round trip.
	return { invoke }
}
