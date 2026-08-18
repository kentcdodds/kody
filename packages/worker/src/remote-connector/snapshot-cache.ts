import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { type RemoteConnectorSnapshot } from '#worker/remote-connector/types.ts'

export const remoteConnectorSnapshotCacheTtlMs = 30_000
export const remoteConnectorSnapshotCacheLimit = 100
export const remoteConnectorSnapshotTimeoutMs = 5_000

export class RemoteConnectorSnapshotTimeoutError extends Error {
	constructor(instanceId: string) {
		super(
			`Remote connector "${instanceId}" snapshot timed out after ${remoteConnectorSnapshotTimeoutMs}ms.`,
		)
		this.name = 'RemoteConnectorSnapshotTimeoutError'
	}
}

async function getSnapshotWithTimeout(input: {
	instanceId: string
	getSnapshot: () => Promise<RemoteConnectorSnapshot | null>
}) {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			input.getSnapshot(),
			new Promise<never>((_resolve, reject) => {
				timeoutId = setTimeout(
					() =>
						reject(new RemoteConnectorSnapshotTimeoutError(input.instanceId)),
					remoteConnectorSnapshotTimeoutMs,
				)
			}),
		])
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
	}
}

function createRemoteConnectorSnapshotCache() {
	return new PromiseLruCache<RemoteConnectorSnapshot | null>({
		ttlMs: remoteConnectorSnapshotCacheTtlMs,
		limit: remoteConnectorSnapshotCacheLimit,
	})
}

let remoteConnectorSnapshotCache = createRemoteConnectorSnapshotCache()

export function createRemoteConnectorSnapshotCacheKey(input: {
	userId: string
	instanceId: string
}) {
	return userScopedConnectorSessionKey(input)
}

export function getCachedRemoteConnectorSnapshot(input: {
	env: Env
	userId: string
	instanceId: string
}): Promise<RemoteConnectorSnapshot | null> {
	const cacheKey = createRemoteConnectorSnapshotCacheKey(input)
	return remoteConnectorSnapshotCache.getOrCreate({
		cacheKey,
		create: async () => {
			const stub = input.env.REMOTE_CONNECTOR_SESSION.get(
				input.env.REMOTE_CONNECTOR_SESSION.idFromName(cacheKey),
			)
			const snapshot = await getSnapshotWithTimeout({
				instanceId: input.instanceId,
				getSnapshot: () => stub.getSnapshot(),
			})
			if (snapshot == null || snapshot.tools.length === 0) {
				// Do not retain disconnected or empty-tool results: a connector
				// that comes online or finishes exposing tools should be visible
				// on the next lookup instead of after the TTL. Empty-tool
				// connected snapshots are the host-gate failure mode for
				// kody.remote[name] ("has not exposed any tools yet").
				remoteConnectorSnapshotCache.delete(cacheKey)
			}
			return snapshot
		},
	})
}

export function invalidateRemoteConnectorSnapshotCache(input: {
	userId: string
	instanceId: string
}) {
	remoteConnectorSnapshotCache.delete(
		createRemoteConnectorSnapshotCacheKey(input),
	)
}

export function clearRemoteConnectorSnapshotCacheForTests() {
	remoteConnectorSnapshotCache = createRemoteConnectorSnapshotCache()
}
