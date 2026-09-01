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
import { synthesizeMcpServerToolDomain } from './mcp-server/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getCachedMcpClientHubSnapshot } from '#worker/mcp-client/hub-client.ts'
import { listVisibleEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'

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
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
}) {
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
	return `${input.userId}:mcp:${mcpServerParts.join('|')}`
}

async function buildCapabilityRegistryForDynamicSources(input: {
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
}): Promise<BuiltCapabilityRegistry> {
	const synthesizedDomains = input.mcpServerRefs
		.map((ref, index) =>
			synthesizeMcpServerToolDomain({
				ref,
				snapshot: input.mcpServerSnapshots[index] ?? null,
			}),
		)
		.flatMap((domain) => (domain ? [domain.domain] : []))
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
	packageId?: string | null
}): Promise<ReadonlyArray<McpServerRef>> {
	try {
		// Per-user 30s cache: registry assembly runs on every execute /
		// package invocation, so this must not cost a D1 read per call.
		return await listVisibleEnabledMcpServerRefsCached({
			env: input.env,
			userId: input.userId,
			packageId: input.packageId,
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

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
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
	const mcpServerRefs = await loadEnabledMcpServerRefs({
		env: input.env,
		userId,
		packageId: input.callerContext.storageContext?.packageId,
	})
	if (mcpServerRefs.length === 0) {
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
	const mcpServerSnapshots = await loadMcpServerSnapshots({
		env: input.env,
		userId,
		refs: mcpServerRefs,
	})
	const cacheKey = createCapabilityRegistryCacheKey({
		userId,
		mcpServerRefs,
		mcpServerSnapshots,
	})
	const registry = await capabilityRegistryCache.getOrCreate({
		cacheKey,
		create: () =>
			buildCapabilityRegistryForDynamicSources({
				mcpServerRefs,
				mcpServerSnapshots,
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
