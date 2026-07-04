import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import { builtinDomains } from './builtin-domains.ts'
import { synthesizeRemoteToolDomain } from './remote-connector/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	normalizeRemoteConnectorRefs,
	type RemoteConnectorRef,
} from '@kody-internal/shared/remote-connectors.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getCachedRemoteConnectorSnapshot } from '#worker/remote-connector/snapshot-cache.ts'
import { type RemoteConnectorSnapshot } from '#worker/remote-connector/types.ts'

const staticRegistry = buildCapabilityRegistry(builtinDomains)

export const capabilityList = staticRegistry.capabilityList

export const capabilityDomains = staticRegistry.capabilityDomains

export const capabilityDomainDescriptionsByName =
	staticRegistry.capabilityDomainDescriptionsByName

export const capabilityMap = staticRegistry.capabilityMap

export const capabilitySpecs = staticRegistry.capabilitySpecs

export const capabilityToolDescriptors =
	staticRegistry.capabilityToolDescriptors

export const capabilityHandlers = staticRegistry.capabilityHandlers

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
}) {
	const connectorParts = input.refs
		.map((ref, index) => {
			const snapshot = input.snapshots[index] ?? null
			const refKey = `${ref.kind.trim().toLowerCase()}:${ref.instanceId.trim()}`
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
	return `${input.userId}:${connectorParts.join('|')}`
}

async function buildCapabilityRegistryForConnectors(input: {
	env: Env
	userId: string
	refs: ReadonlyArray<RemoteConnectorRef>
	snapshots: ReadonlyArray<RemoteConnectorSnapshot | null>
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
	const synthesizedDomains = synthesized.flatMap((domain) =>
		domain ? [domain.domain] : [],
	)
	if (synthesizedDomains.length === 0) {
		return staticRegistry
	}
	return buildCapabilityRegistry([...builtinDomains, ...synthesizedDomains])
}

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return staticRegistry
	}
	const snapshots = await Promise.all(
		refs.map((ref) =>
			getCachedRemoteConnectorSnapshot({
				env: input.env,
				userId,
				kind: ref.kind,
				instanceId: ref.instanceId,
			}),
		),
	)
	const cacheKey = createCapabilityRegistryCacheKey({
		userId,
		refs,
		snapshots,
	})
	return capabilityRegistryCache.getOrCreate({
		cacheKey,
		create: () =>
			buildCapabilityRegistryForConnectors({
				env: input.env,
				userId,
				refs,
				snapshots,
			}),
	})
}

export function clearCapabilityRegistryCacheForTests() {
	capabilityRegistryCache = createCapabilityRegistryCache()
}
