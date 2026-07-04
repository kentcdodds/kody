import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { type RemoteConnectorSnapshot } from '#worker/remote-connector/types.ts'

export const remoteConnectorSnapshotCacheTtlMs = 30_000
export const remoteConnectorSnapshotCacheLimit = 100

function createRemoteConnectorSnapshotCache() {
	return new PromiseLruCache<RemoteConnectorSnapshot | null>({
		ttlMs: remoteConnectorSnapshotCacheTtlMs,
		limit: remoteConnectorSnapshotCacheLimit,
	})
}

let remoteConnectorSnapshotCache = createRemoteConnectorSnapshotCache()

export function createRemoteConnectorSnapshotCacheKey(input: {
	userId: string
	kind: string
	instanceId: string
}) {
	return userScopedConnectorSessionKey(input)
}

export function getCachedRemoteConnectorSnapshot(input: {
	env: Env
	userId: string
	kind: string
	instanceId: string
}): Promise<RemoteConnectorSnapshot | null> {
	const cacheKey = createRemoteConnectorSnapshotCacheKey(input)
	return remoteConnectorSnapshotCache.getOrCreate({
		cacheKey,
		create: async () => {
			const stub = input.env.REMOTE_CONNECTOR_SESSION.get(
				input.env.REMOTE_CONNECTOR_SESSION.idFromName(cacheKey),
			)
			const snapshot = await stub.getSnapshot()
			if (snapshot == null) {
				// Do not retain disconnected results: a connector that comes online
				// should be visible on the next lookup instead of after the TTL.
				remoteConnectorSnapshotCache.delete(cacheKey)
			}
			return snapshot
		},
	})
}

export function invalidateRemoteConnectorSnapshotCache(input: {
	userId: string
	kind: string
	instanceId: string
}) {
	remoteConnectorSnapshotCache.delete(
		createRemoteConnectorSnapshotCacheKey(input),
	)
}

export function clearRemoteConnectorSnapshotCacheForTests() {
	remoteConnectorSnapshotCache = createRemoteConnectorSnapshotCache()
}
