import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { recordAgentPackageConversationUse } from '#worker/usage/agent-package-conversation-uses.ts'
import {
	buildSavedPackageNotFoundMessage,
	internalExecuteRuntimeInvokeTokenId,
	internalPackageRuntimeInvokeTokenId,
	normalizeExportName,
	normalizeNullableString,
	packageInvocationScopeWildcard,
	type PackageInvocationRequest,
	type PackageInvocationResponse,
	type PackageInvocationTokenScope,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { invokeSavedPackageModule } from './idempotent-module-invocation.ts'
import { runSavedPackageModuleEphemeral } from './module-execution.ts'
import { type PackageInvokeCheckPreloads } from './invoke-check.ts'
import { resolveSavedPackage } from './module-artifacts.ts'
import { buildJsonErrorResponse } from './responses.ts'

function scopeAllowsValue(input: { values?: Array<string>; value: string }) {
	return (
		input.values?.includes(packageInvocationScopeWildcard) ||
		input.values?.includes(input.value) ||
		false
	)
}

function tokenAllowsPackage(input: {
	token: PackageInvocationTokenScope
	savedPackage: NonNullable<Awaited<ReturnType<typeof resolveSavedPackage>>>
}) {
	return (
		scopeAllowsValue({
			values: input.token.packageIds,
			value: input.savedPackage.id,
		}) ||
		scopeAllowsValue({
			values: input.token.packageKodyIds,
			value: input.savedPackage.kodyId,
		})
	)
}

function tokenAllowsExport(input: {
	token: PackageInvocationTokenScope
	exportName: string
}) {
	const exportNames = input.token.exportNames ?? []
	return exportNames.some(
		(entry) =>
			entry === packageInvocationScopeWildcard ||
			normalizeExportName(entry) === input.exportName,
	)
}

function tokenAllowsSource(input: {
	token: PackageInvocationTokenScope
	source: string | null
}) {
	if (!input.source) return true
	const sources = input.token.sources ?? []
	return sources.includes(input.source)
}

export async function invokePackageExportForExecuteRuntime(input: {
	env: Env
	baseUrl: string
	caller: {
		userId: string
		email: string
		displayName: string
		remoteConnectors?: Array<RemoteConnectorRef> | null
	}
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
	conversationId?: string | null
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/** Check-phase loads from the `packages.invoke` contract check; see invoke-check.ts. */
	preloads?: PackageInvokeCheckPreloads | null
	signal?: AbortSignal
}): Promise<PackageInvocationResponse> {
	const packageIdOrKodyId = input.request.packageIdOrKodyId.trim()
	if (!packageIdOrKodyId) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'invalid_package',
			message: 'Package id or kody id is required.',
		})
	}
	const exportName = normalizeExportName(input.request.exportName)
	const idempotencyKey = normalizeNullableString(input.request.idempotencyKey)
	const savedPackage =
		input.preloads?.savedPackage ??
		(await resolveSavedPackage({
			db: input.env.APP_DB,
			userId: input.caller.userId,
			packageIdOrKodyId,
		}))
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: buildSavedPackageNotFoundMessage(packageIdOrKodyId),
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	const conversationId = input.conversationId?.trim()
	if (conversationId) {
		// Best-effort; must not affect invoke. Conversation-unique upsert.
		void recordAgentPackageConversationUse(input.env, {
			userId: input.caller.userId,
			packageId: savedPackage.id,
			conversationId,
		})
	}
	const actor = {
		tokenId: internalExecuteRuntimeInvokeTokenId,
		userId: input.caller.userId,
		email: input.caller.email,
		displayName: input.caller.displayName || input.caller.email || 'execute',
		remoteConnectors: input.caller.remoteConnectors ?? null,
	}
	const shared = {
		env: input.env,
		baseUrl: input.baseUrl,
		actor,
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export',
			exportName,
		},
		params: input.request.params,
		source: 'execute',
		topic: normalizeNullableString(input.request.topic),
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
		preloadedModuleArtifact: input.preloads?.moduleArtifact ?? null,
		signal: input.signal,
	} satisfies Omit<
		Parameters<typeof invokeSavedPackageModule>[0],
		'idempotencyKey'
	>
	if (!idempotencyKey) {
		return await runSavedPackageModuleEphemeral(shared)
	}
	return await invokeSavedPackageModule({ ...shared, idempotencyKey })
}

export async function invokePackageExportForPackageRuntime(input: {
	env: Env
	baseUrl: string
	caller: {
		userId: string
		email: string
		displayName: string
		remoteConnectors?: Array<RemoteConnectorRef> | null
		packageContext: PackageRuntimeContext
	}
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/** Check-phase loads from the `packages.invoke` contract check; see invoke-check.ts. */
	preloads?: PackageInvokeCheckPreloads | null
	signal?: AbortSignal
}): Promise<PackageInvocationResponse> {
	const packageIdOrKodyId = input.request.packageIdOrKodyId.trim()
	if (!packageIdOrKodyId) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'invalid_package',
			message: 'Package id or kody id is required.',
		})
	}
	const exportName = normalizeExportName(input.request.exportName)
	const idempotencyKey = normalizeNullableString(input.request.idempotencyKey)
	const savedPackage =
		input.preloads?.savedPackage ??
		(await resolveSavedPackage({
			db: input.env.APP_DB,
			userId: input.caller.userId,
			packageIdOrKodyId,
		}))
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: buildSavedPackageNotFoundMessage(packageIdOrKodyId),
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	const shared = {
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: `${internalPackageRuntimeInvokeTokenId}:${input.caller.packageContext.packageId}`,
			userId: input.caller.userId,
			email: input.caller.email,
			displayName:
				input.caller.displayName ||
				`package:${input.caller.packageContext.kodyId}`,
			remoteConnectors: input.caller.remoteConnectors ?? null,
		},
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export',
			exportName,
		},
		params: input.request.params,
		source:
			normalizeNullableString(input.request.source) ??
			`package:${input.caller.packageContext.kodyId}`,
		topic: normalizeNullableString(input.request.topic),
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
		preloadedModuleArtifact: input.preloads?.moduleArtifact ?? null,
		signal: input.signal,
	} satisfies Omit<
		Parameters<typeof invokeSavedPackageModule>[0],
		'idempotencyKey'
	>
	if (!idempotencyKey) {
		return await runSavedPackageModuleEphemeral(shared)
	}
	return await invokeSavedPackageModule({ ...shared, idempotencyKey })
}

export async function invokePackageExportWithToolFactories(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Internal workflow runner: skip the idempotency ledger so Cloudflare
	 * Workflow step retries re-execute instead of replaying a cached timeout.
	 */
	ephemeral?: boolean
	executorTimeoutMs?: number | null
}): Promise<PackageInvocationResponse> {
	const packageIdOrKodyId = input.request.packageIdOrKodyId.trim()
	if (!packageIdOrKodyId) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'invalid_package',
			message: 'Package id or kody id is required.',
		})
	}
	const exportName = normalizeExportName(input.request.exportName)
	// External HTTP token invocations stay keyed-only: providers retry
	// deliveries, so exactly-once is the point of this surface. Workflow
	// step retries pass ephemeral: true and run key-less instead.
	const idempotencyKey = input.ephemeral
		? null
		: normalizeNullableString(input.request.idempotencyKey)
	if (!input.ephemeral && !idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message: 'Package invocations require a non-empty idempotencyKey.',
		})
	}
	const source = normalizeNullableString(input.request.source)
	const topic = normalizeNullableString(input.request.topic)
	if (!tokenAllowsSource({ token: input.token, source })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'source_not_allowed',
			message: 'This token is not allowed to invoke the requested source.',
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.token.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: buildSavedPackageNotFoundMessage(packageIdOrKodyId),
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	if (!tokenAllowsPackage({ token: input.token, savedPackage })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'package_not_allowed',
			message: 'This token is not allowed to invoke the requested package.',
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}
	if (!tokenAllowsExport({ token: input.token, exportName })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'export_not_allowed',
			message: `This token is not allowed to invoke export "${exportName}".`,
			idempotencyKey: idempotencyKey ?? undefined,
		})
	}

	const shared = {
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: input.token.tokenId,
			userId: input.token.userId,
			email: input.token.email,
			displayName: input.token.displayName,
			remoteConnectors: input.token.remoteConnectors ?? null,
		},
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export' as const,
			exportName,
		},
		params: input.request.params,
		source,
		topic,
		notFoundCode: 'export_not_found' as const,
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
		executorTimeoutMs: input.executorTimeoutMs,
	}

	if (!idempotencyKey) {
		return await runSavedPackageModuleEphemeral(shared)
	}

	return await invokeSavedPackageModule({
		...shared,
		idempotencyKey,
	})
}
