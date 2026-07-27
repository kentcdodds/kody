import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import {
	filterCapabilityRegistryForCaller,
	resolveCallerFeatureFlags,
	type CallerFeatureFlags,
} from './access-control.ts'
import { builtinDomains } from './builtin-domains.ts'
import { synthesizeRemoteToolDomain } from './remote-connector/index.ts'
import { synthesizeMcpServerToolDomain } from './mcp-server/index.ts'
import { synthesizeOpenApiProviderDomain } from './openapi-provider/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import {
	normalizeRemoteConnectorRefs,
	type RemoteConnectorRef,
} from '@kody-internal/shared/remote-connectors.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getCachedMcpClientHubSnapshot } from '#worker/mcp-client/hub-client.ts'
import { listEnabledMcpServerRefs } from '#worker/mcp-client/settings-service.ts'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'
import { getCachedRemoteConnectorSnapshot } from '#worker/remote-connector/snapshot-cache.ts'
import { type RemoteConnectorSnapshot } from '#worker/remote-connector/types.ts'
import { type OpenApiBinding } from '#worker/openapi/binding-shared.ts'
import { listOpenApiBindings } from '#worker/openapi/binding-service.ts'

let staticRegistryMemo: BuiltCapabilityRegistry | null = null

/**
 * Building the builtin registry converts ~99 capability Zod schemas to JSON
 * Schema, which is far too expensive to run at module scope on every isolate
 * cold start. Memoized so the work happens at most once per isolate, on first
 * use.
 */
export function getStaticRegistry(): BuiltCapabilityRegistry {
	staticRegistryMemo ??= buildCapabilityRegistry(builtinDomains)
	return staticRegistryMemo
}

export const capabilityRegistryCacheTtlMs = 30_000
export const capabilityRegistryCacheLimit = 50

function createCapabilityRegistryCache() {
	return new PromiseLruCache<BuiltCapabilityRegistry>({
		ttlMs: capabilityRegistryCacheTtlMs,
		limit: capabilityRegistryCacheLimit,
	})
}

let capabilityRegistryCache = createCapabilityRegistryCache()

function createCapabilityRegistryCacheKey(input: {
	userId: string
	refs: ReadonlyArray<RemoteConnectorRef>
	snapshots: ReadonlyArray<RemoteConnectorSnapshot | null>
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
	openApiBindings: ReadonlyArray<OpenApiBinding>
}) {
	const connectorParts = input.refs
		.map((ref, index) => {
			const snapshot = input.snapshots[index] ?? null
			const refKey = ref.instanceId.trim()
			if (!snapshot) {
				return `${refKey}:disconnected`
			}
			const toolNames = snapshot.tools
				.map((tool) => tool.name)
				.sort()
				.join(',')
			return `${refKey}:${snapshot.connectorId}:${snapshot.connectedAt}:${toolNames}`
		})
		.sort()
	const mcpServerParts = input.mcpServerRefs
		.map((ref, index) => {
			const snapshot = input.mcpServerSnapshots[index] ?? null
			const refKey = `${ref.serverId}:${ref.name}`
			if (!snapshot || snapshot.state !== 'ready') {
				return `${refKey}:${snapshot?.state ?? 'disconnected'}`
			}
			const toolNames = snapshot.tools
				.map((tool) => tool.name)
				.sort()
				.join(',')
			return `${refKey}:ready:${toolNames}`
		})
		.sort()
	const openApiParts = input.openApiBindings
		.map(
			(binding) =>
				`${binding.name}:${binding.updatedAt}:${binding.operations.length}`,
		)
		.sort()
	return `${input.userId}:${connectorParts.join('|')}:mcp:${mcpServerParts.join('|')}:openapi:${openApiParts.join('|')}`
}

async function buildCapabilityRegistryForDynamicSources(input: {
	env: Env
	userId: string
	refs: ReadonlyArray<RemoteConnectorRef>
	snapshots: ReadonlyArray<RemoteConnectorSnapshot | null>
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
	openApiBindings: ReadonlyArray<OpenApiBinding>
}): Promise<BuiltCapabilityRegistry> {
	const synthesized = await Promise.all(
		input.refs.map((ref, index) =>
			synthesizeRemoteToolDomain({
				env: input.env,
				userId: input.userId,
				ref,
				snapshot: input.snapshots[index] ?? null,
			}),
		),
	)
	const synthesizedMcpServers = input.mcpServerRefs.map((ref, index) =>
		synthesizeMcpServerToolDomain({
			ref,
			snapshot: input.mcpServerSnapshots[index] ?? null,
		}),
	)
	const synthesizedOpenApiProviders = input.openApiBindings.map((binding) =>
		synthesizeOpenApiProviderDomain({ binding }),
	)
	const synthesizedDomains = [
		...synthesized,
		...synthesizedMcpServers,
		...synthesizedOpenApiProviders,
	].flatMap((domain) => (domain ? [domain.domain] : []))
	if (synthesizedDomains.length === 0) {
		return getStaticRegistry()
	}
	return buildCapabilityRegistry([...builtinDomains, ...synthesizedDomains])
}

function filterRegistryForContext(input: {
	registry: BuiltCapabilityRegistry
	callerContext: McpCallerContext
	featureFlags: CallerFeatureFlags | null
}) {
	return filterCapabilityRegistryForCaller(
		input.registry,
		input.callerContext,
		input.featureFlags,
	)
}

async function resolveFeatureFlagsForRegistry(input: {
	env: Env
	callerContext: McpCallerContext
	registry: BuiltCapabilityRegistry
}): Promise<CallerFeatureFlags | null> {
	// Skip the D1 reads when nothing in this registry is gated by a flag.
	// `callerCanAccessCapability` already fails closed on a missing map.
	if (
		!input.registry.capabilityList.some((capability) => capability.featureFlag)
	) {
		return null
	}
	return resolveCallerFeatureFlags(input.env, input.callerContext)
}

async function loadEnabledMcpServerRefs(input: {
	env: Env
	userId: string
}): Promise<Array<McpServerRef>> {
	try {
		return await listEnabledMcpServerRefs({
			env: input.env,
			userId: input.userId,
		})
	} catch {
		// A missing/unavailable settings table must not break builtin
		// capabilities; the caller just sees no MCP server domains.
		return []
	}
}

async function loadMcpServerSnapshots(input: {
	env: Env
	userId: string
	refs: ReadonlyArray<McpServerRef>
}): Promise<Array<McpServerSnapshot | null>> {
	if (input.refs.length === 0) return []
	try {
		const hubSnapshot = await getCachedMcpClientHubSnapshot({
			env: input.env,
			userId: input.userId,
		})
		return input.refs.map(
			(ref) =>
				hubSnapshot.servers.find(
					(server) => server.serverId === ref.serverId,
				) ?? null,
		)
	} catch {
		// A hub that cannot be reached must not break builtin capabilities.
		return input.refs.map(() => null)
	}
}

async function loadRemoteConnectorSnapshots(input: {
	env: Env
	userId: string
	refs: ReadonlyArray<RemoteConnectorRef>
}): Promise<Array<RemoteConnectorSnapshot | null>> {
	return await Promise.all(
		input.refs.map(async (ref) => {
			try {
				return await getCachedRemoteConnectorSnapshot({
					env: input.env,
					userId: input.userId,
					instanceId: ref.instanceId,
				})
			} catch {
				// A stalled or unavailable connector must not prevent builtin or
				// healthy dynamic capabilities from being discovered.
				return null
			}
		}),
	)
}

async function loadOpenApiBindingsForRegistry(input: {
	env: Env
	userId: string
}): Promise<Array<OpenApiBinding>> {
	try {
		return await listOpenApiBindings({
			env: input.env,
			userId: input.userId,
		})
	} catch {
		// A binding-store failure must not break builtin capabilities.
		return []
	}
}

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) {
		const registry = getStaticRegistry()
		return filterRegistryForContext({
			registry,
			callerContext: input.callerContext,
			featureFlags: await resolveFeatureFlagsForRegistry({
				env: input.env,
				callerContext: input.callerContext,
				registry,
			}),
		})
	}
	const [mcpServerRefs, openApiBindings] = await Promise.all([
		loadEnabledMcpServerRefs({
			env: input.env,
			userId,
		}),
		loadOpenApiBindingsForRegistry({
			env: input.env,
			userId,
		}),
	])
	if (
		refs.length === 0 &&
		mcpServerRefs.length === 0 &&
		openApiBindings.length === 0
	) {
		const registry = getStaticRegistry()
		return filterRegistryForContext({
			registry,
			callerContext: input.callerContext,
			featureFlags: await resolveFeatureFlagsForRegistry({
				env: input.env,
				callerContext: input.callerContext,
				registry,
			}),
		})
	}
	const [snapshots, mcpServerSnapshots] = await Promise.all([
		loadRemoteConnectorSnapshots({
			env: input.env,
			userId,
			refs,
		}),
		loadMcpServerSnapshots({
			env: input.env,
			userId,
			refs: mcpServerRefs,
		}),
	])
	const cacheKey = createCapabilityRegistryCacheKey({
		userId,
		refs,
		snapshots,
		mcpServerRefs,
		mcpServerSnapshots,
		openApiBindings,
	})
	const registry = await capabilityRegistryCache.getOrCreate({
		cacheKey,
		create: () =>
			buildCapabilityRegistryForDynamicSources({
				env: input.env,
				userId,
				refs,
				snapshots,
				mcpServerRefs,
				mcpServerSnapshots,
				openApiBindings,
			}),
	})
	return filterRegistryForContext({
		registry,
		callerContext: input.callerContext,
		featureFlags: await resolveFeatureFlagsForRegistry({
			env: input.env,
			callerContext: input.callerContext,
			registry,
		}),
	})
}

export function clearCapabilityRegistryCacheForTests() {
	capabilityRegistryCache = createCapabilityRegistryCache()
}
