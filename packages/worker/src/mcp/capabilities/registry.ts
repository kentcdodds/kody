import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import { filterCapabilityRegistryForCaller } from './access-control.ts'
import { builtinDomains } from './builtin-domains.ts'
import { synthesizeRemoteToolDomain } from './remote-connector/index.ts'
import { synthesizeMcpServerToolDomain } from './mcp-server/index.ts'
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

/**
 * Lazy view over one field of the static registry, so the legacy constant
 * exports below keep working without forcing the registry build at module
 * load. The proxy target only supplies the right base shape (array vs plain
 * object); every operation is forwarded to the real, memoized registry.
 */
function lazyStaticRegistryField<Key extends keyof BuiltCapabilityRegistry>(
	key: Key,
	target: object,
): BuiltCapabilityRegistry[Key] {
	const resolve = () => getStaticRegistry()[key] as object
	return new Proxy(target, {
		get(_target, property) {
			return Reflect.get(resolve(), property)
		},
		has(_target, property) {
			return Reflect.has(resolve(), property)
		},
		ownKeys() {
			return Reflect.ownKeys(resolve())
		},
		getOwnPropertyDescriptor(_target, property) {
			return Object.getOwnPropertyDescriptor(resolve(), property)
		},
	}) as BuiltCapabilityRegistry[Key]
}

export const capabilityList = lazyStaticRegistryField('capabilityList', [])

export const capabilityDomains = lazyStaticRegistryField(
	'capabilityDomains',
	[],
)

export const capabilityDomainDescriptionsByName = lazyStaticRegistryField(
	'capabilityDomainDescriptionsByName',
	{},
)

export const capabilityMap = lazyStaticRegistryField('capabilityMap', {})

export const capabilitySpecs = lazyStaticRegistryField('capabilitySpecs', {})

export const capabilityToolDescriptors = lazyStaticRegistryField(
	'capabilityToolDescriptors',
	{},
)

export const capabilityHandlers = lazyStaticRegistryField(
	'capabilityHandlers',
	{},
)

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
	return `${input.userId}:${connectorParts.join('|')}:mcp:${mcpServerParts.join('|')}`
}

async function buildCapabilityRegistryForDynamicSources(input: {
	env: Env
	userId: string
	refs: ReadonlyArray<RemoteConnectorRef>
	snapshots: ReadonlyArray<RemoteConnectorSnapshot | null>
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
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
	const synthesizedDomains = [...synthesized, ...synthesizedMcpServers].flatMap(
		(domain) => (domain ? [domain.domain] : []),
	)
	if (synthesizedDomains.length === 0) {
		return getStaticRegistry()
	}
	return buildCapabilityRegistry([...builtinDomains, ...synthesizedDomains])
}

function filterRegistryForContext(input: {
	registry: BuiltCapabilityRegistry
	callerContext: McpCallerContext
}) {
	return filterCapabilityRegistryForCaller(input.registry, input.callerContext)
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

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) {
		return filterRegistryForContext({
			registry: getStaticRegistry(),
			callerContext: input.callerContext,
		})
	}
	const mcpServerRefs = await loadEnabledMcpServerRefs({
		env: input.env,
		userId,
	})
	if (refs.length === 0 && mcpServerRefs.length === 0) {
		return filterRegistryForContext({
			registry: getStaticRegistry(),
			callerContext: input.callerContext,
		})
	}
	const [snapshots, mcpServerSnapshots] = await Promise.all([
		Promise.all(
			refs.map((ref) =>
				getCachedRemoteConnectorSnapshot({
					env: input.env,
					userId,
					instanceId: ref.instanceId,
				}),
			),
		),
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
			}),
	})
	return filterRegistryForContext({
		registry,
		callerContext: input.callerContext,
	})
}

export function clearCapabilityRegistryCacheForTests() {
	capabilityRegistryCache = createCapabilityRegistryCache()
}
