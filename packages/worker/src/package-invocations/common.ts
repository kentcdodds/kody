import { normalizePackageInvocationExportName } from '@kody-internal/shared/public-urls.ts'
import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import {
	type PackageEventTools,
	type PackageInvokeTools,
} from '#mcp/run-kody-registry.ts'
import { type createMcpCallerContext } from '#mcp/context.ts'
import {
	type PackageRuntimeDebugContext,
	type PackageRuntimeSurface,
} from '#worker/package-runtime/package-runtime-debug.ts'
import { packageWorkflowInvocationSource } from '#worker/package-runtime/package-invocation-sources.ts'
import { type listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { buildPackageStorageId } from '#worker/storage-runner.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type PackageInvocationStoredResponse } from './repo.ts'

export type PackageInvocationTokenScope = {
	tokenId: string
	userId: string
	email: string
	displayName: string
	packageIds?: Array<string>
	packageKodyIds?: Array<string>
	exportNames?: Array<string>
	sources?: Array<string>
	remoteConnectors?: Array<RemoteConnectorRef>
}

export type PackageInvocationRequest = {
	packageIdOrKodyId: string
	exportName: string
	params?: Record<string, unknown>
	idempotencyKey: string
	source?: string | null
	topic?: string | null
}

export type PackageInvocationResponse = PackageInvocationStoredResponse

export type PackageInvocationActor = {
	tokenId: string
	userId: string
	email: string
	displayName: string
	remoteConnectors?: Array<RemoteConnectorRef> | null
}

export type PackageModuleSelector =
	| {
			kind: 'export'
			exportName: string
	  }
	| {
			kind: 'subscription'
			topic: string
	  }

export type PackageModuleResolution = {
	artifactName: string
	entryPoint: string
}

export type PackageRuntimeContext = {
	packageId: string
	kodyId: string
	sourceId?: string | null
}

export type LoadedPackageEventSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

export type PackageRuntimeToolFactoryInput = {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRuntimeDebug?: PackageRuntimeDebugContext | null
	packageInvokeDepth?: number
}

export type PackageRuntimeToolFactories = {
	createPackageRuntimeInvokeTools(
		input: PackageRuntimeToolFactoryInput,
	): PackageInvokeTools
	createPackageEventTools(
		input: PackageRuntimeToolFactoryInput,
	): PackageEventTools
}

export const internalEmailSubscriptionTokenId = 'internal:email-subscriptions'
export const internalPackageEventSubscriptionTokenId = 'internal:package-events'
export const internalPackageRuntimeInvokeTokenId = 'internal:package-runtime'
export const internalExecuteRuntimeInvokeTokenId = 'internal:execute-runtime'
export const maxPackageRuntimeInvokeDepth = 8
export const packageInvocationScopeWildcard = '*'

export function normalizeExportName(exportName: string) {
	return normalizePackageInvocationExportName(exportName)
}

export function normalizeNullableString(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export function buildPackageInvocationStorageId(packageId: string) {
	// Shared with packageStorage() so all surfaces name the same bucket. Since
	// the ambient `storage` binding was removed from invocation runs, this only
	// feeds `callerContext.storageContext` (secret scoping and runtime-debug
	// metadata) — package code reaches the bucket via `packageStorage()`.
	return buildPackageStorageId(packageId)
}

export function createRepoContext(source: EntitySourceRow) {
	return {
		sourceId: source.id,
		repoId: source.repo_id,
		sessionId: null,
		baseCommit: source.published_commit,
		manifestPath: source.manifest_path,
		sourceRoot: source.source_root,
		publishedCommit: source.published_commit,
		entityKind: source.entity_kind,
		entityId: source.entity_id,
	}
}

export function resolveInvocationRuntimeSurface(input: {
	selector: PackageModuleSelector
	source: string | null
}): PackageRuntimeSurface {
	if (input.source === packageWorkflowInvocationSource) return 'workflow'
	switch (input.selector.kind) {
		case 'export':
			return 'export'
		case 'subscription':
			return 'subscription'
		default: {
			const selector: never = input.selector
			void selector
			throw new Error('Unhandled package module selector.')
		}
	}
}

export function resolveInvocationRuntimeName(input: {
	surface: PackageRuntimeSurface
	invocationName: string
	topic: string | null
}) {
	switch (input.surface) {
		case 'workflow':
		case 'subscription':
			return input.topic ?? input.invocationName
		case 'export':
			return input.invocationName
		case 'app_fetch':
		case 'app_realtime':
		case 'service':
		case 'job':
		case 'retriever':
			return input.invocationName
		default: {
			const surface: never = input.surface
			void surface
			throw new Error('Unhandled package runtime surface.')
		}
	}
}
