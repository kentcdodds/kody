import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { recordAgentPackageConversationUse } from '#worker/usage/agent-package-conversation-uses.ts'
import {
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
	const idempotencyKey = input.request.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message: 'Package invocations require a non-empty idempotencyKey.',
		})
	}
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.caller.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: `Saved package "${packageIdOrKodyId}" was not found for this user.`,
			idempotencyKey,
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
	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: internalExecuteRuntimeInvokeTokenId,
			userId: input.caller.userId,
			email: input.caller.email,
			displayName: input.caller.displayName || input.caller.email || 'execute',
			remoteConnectors: input.caller.remoteConnectors ?? null,
		},
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export',
			exportName,
		},
		params: input.request.params,
		idempotencyKey,
		source: 'execute',
		topic: normalizeNullableString(input.request.topic),
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
	})
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
	const idempotencyKey = input.request.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message: 'Package invocations require a non-empty idempotencyKey.',
		})
	}
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.caller.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: `Saved package "${packageIdOrKodyId}" was not found for this user.`,
			idempotencyKey,
		})
	}
	return await invokeSavedPackageModule({
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
		idempotencyKey,
		source:
			normalizeNullableString(input.request.source) ??
			`package:${input.caller.packageContext.kodyId}`,
		topic: normalizeNullableString(input.request.topic),
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
	})
}

export async function invokePackageExportWithToolFactories(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
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
	const idempotencyKey = input.request.idempotencyKey.trim()
	if (!idempotencyKey) {
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
			idempotencyKey,
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
			message: `Saved package "${packageIdOrKodyId}" was not found for this user.`,
			idempotencyKey,
		})
	}
	if (!tokenAllowsPackage({ token: input.token, savedPackage })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'package_not_allowed',
			message: 'This token is not allowed to invoke the requested package.',
			idempotencyKey,
		})
	}
	if (!tokenAllowsExport({ token: input.token, exportName })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'export_not_allowed',
			message: `This token is not allowed to invoke export "${exportName}".`,
			idempotencyKey,
		})
	}

	return await invokeSavedPackageModule({
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
			kind: 'export',
			exportName,
		},
		params: input.request.params,
		idempotencyKey,
		source,
		topic,
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
	})
}
