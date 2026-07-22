import { type createMcpCallerContext } from '#mcp/context.ts'
import {
	type PackageEventTools,
	type PackageInvokeTools,
} from '#mcp/run-kody-registry.ts'
import { type PackageRuntimeDebugContext } from '#worker/package-runtime/package-runtime-debug.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	normalizeExportName,
	packageInvocationScopeWildcard,
	type PackageInvocationRequest,
	type PackageInvocationResponse,
	type PackageInvocationTokenScope,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { invokePackageExportWithToolFactories } from './http-invoke.ts'
import {
	createExecutePackageInvokeToolsWithToolFactories,
	createPackageRuntimeInvokeToolsWithToolFactories,
} from './runtime-tool-factories.ts'
import {
	createPackageEventToolsWithToolFactories,
	invokePackageSubscriptionWithToolFactories,
} from './subscription-dispatch.ts'

export {
	normalizeExportName,
	packageInvocationScopeWildcard,
	type PackageInvocationRequest,
	type PackageInvocationResponse,
	type PackageInvocationTokenScope,
}

const packageRuntimeToolFactories: PackageRuntimeToolFactories = {
	createPackageRuntimeInvokeTools(input) {
		return createPackageRuntimeInvokeToolsWithToolFactories({
			...input,
			toolFactories: packageRuntimeToolFactories,
		})
	},
	createPackageEventTools(input) {
		return createPackageEventToolsWithToolFactories({
			...input,
			toolFactories: packageRuntimeToolFactories,
		})
	},
}

export function createPackageRuntimeInvokeTools(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRuntimeDebug?: PackageRuntimeDebugContext | null
	packageInvokeDepth?: number
}): PackageInvokeTools {
	return createPackageRuntimeInvokeToolsWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export function createPackageEventTools(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRuntimeDebug?: PackageRuntimeDebugContext | null
	packageInvokeDepth?: number
}): PackageEventTools {
	return createPackageEventToolsWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export function createExecutePackageInvokeTools(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	parentRuntimeDebug?: PackageRuntimeDebugContext | null
	packageInvokeDepth?: number
	/** MCP execute conversation id for agent-facing popularity recording. */
	conversationId?: string | null
}): PackageInvokeTools {
	return createExecutePackageInvokeToolsWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export async function invokePackageExport(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
}): Promise<PackageInvocationResponse> {
	return await invokePackageExportWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}

export async function invokePackageSubscription(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	topic: string
	params?: Record<string, unknown>
	idempotencyKey: string
	source?: string | null
	actorTokenId?: string
	actorDisplayName?: string
	runtimeInvokeDepth?: number
}) {
	return await invokePackageSubscriptionWithToolFactories({
		...input,
		toolFactories: packageRuntimeToolFactories,
	})
}
