import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import {
	listSavedPackagesByIds,
	listSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

const topicMapScanConcurrency = 5

async function mapSettledInChunks<T, TResult>(
	items: ReadonlyArray<T>,
	mapper: (item: T) => Promise<TResult>,
) {
	const results: Array<PromiseSettledResult<TResult>> = []
	for (const itemChunk of chunkArray(items, topicMapScanConcurrency)) {
		results.push(...(await Promise.allSettled(itemChunk.map(mapper))))
	}
	return results
}

/**
 * Per-user KV cache of computed topic → package-id lists for package-event
 * subscription discovery.
 *
 * The package manifest remains the only source of truth. This key is a cache of
 * that computed projection: wakes read one KV value instead of every saved
 * package's manifest. Prefer a normalized source of truth plus a cache of
 * computed values over a denormalized topic-index table.
 *
 * Invalidation: publish and unpublish delete (then rebuild) this key in the
 * same write path. There is no TTL — a TTL could hide a newly published
 * subscription until expiry.
 */

export const packageSubscriptionTopicMapVersion = 1
export const packageSubscriptionTopicMapPrefix = 'package-subscription-topics'

export type PackageSubscriptionTopicMap = {
	version: typeof packageSubscriptionTopicMapVersion
	userId: string
	byTopic: Record<string, Array<string>>
	cachedAt: string
}

type SubscriptionTopicCacheEnv = Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>

function getSubscriptionTopicKv(env: SubscriptionTopicCacheEnv) {
	const kv = (env as { BUNDLE_ARTIFACTS_KV?: KVNamespace }).BUNDLE_ARTIFACTS_KV
	if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
		return null
	}
	return kv
}

export function buildPackageSubscriptionTopicMapKey(userId: string) {
	return [
		packageSubscriptionTopicMapPrefix,
		`v${packageSubscriptionTopicMapVersion}`,
		userId,
	].join(':')
}

function isPackageSubscriptionTopicMap(
	value: unknown,
	userId: string,
): value is PackageSubscriptionTopicMap {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false
	}
	const record = value as Record<string, unknown>
	if (record['version'] !== packageSubscriptionTopicMapVersion) return false
	if (record['userId'] !== userId) return false
	const byTopic = record['byTopic']
	if (!byTopic || typeof byTopic !== 'object' || Array.isArray(byTopic)) {
		return false
	}
	for (const [topic, packageIds] of Object.entries(
		byTopic as Record<string, unknown>,
	)) {
		if (typeof topic !== 'string' || topic.trim().length === 0) return false
		if (!Array.isArray(packageIds)) return false
		if (
			!packageIds.every(
				(packageId) =>
					typeof packageId === 'string' && packageId.trim().length > 0,
			)
		) {
			return false
		}
	}
	return typeof record['cachedAt'] === 'string'
}

function emptyTopicMap(userId: string): PackageSubscriptionTopicMap {
	return {
		version: packageSubscriptionTopicMapVersion,
		userId,
		byTopic: {},
		cachedAt: new Date().toISOString(),
	}
}

function isMissingSavedPackagesTableError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.toLowerCase().includes('no such table: saved_packages')
	)
}

/**
 * Scan every saved package manifest for the user and build the topic map.
 * Manifest load failures are skipped (best-effort) so a single broken package
 * cannot leave discovery without a map.
 */
export async function scanPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
}): Promise<PackageSubscriptionTopicMap> {
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		if (isMissingSavedPackagesTableError(error)) {
			return emptyTopicMap(input.userId)
		}
		throw error
	}
	const byTopic = new Map<string, Set<string>>()
	const settled = await mapSettledInChunks(
		savedPackages,
		async (savedPackage) => {
			const loaded = await loadPackageManifestBySourceId({
				env: input.env as Env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})
			return {
				packageId: savedPackage.id,
				topics: listPackageSubscriptions(loaded.manifest).map(
					(subscription) => subscription.topic,
				),
			}
		},
	)
	for (const [index, result] of settled.entries()) {
		if (result.status !== 'fulfilled') {
			const savedPackage = savedPackages[index]
			console.warn('package-subscription-topic-map-manifest-load-failed', {
				userId: input.userId,
				packageId: savedPackage?.id,
				sourceId: savedPackage?.sourceId,
				error: result.reason,
			})
			continue
		}
		for (const topic of result.value.topics) {
			const packageIds = byTopic.get(topic) ?? new Set<string>()
			packageIds.add(result.value.packageId)
			byTopic.set(topic, packageIds)
		}
	}
	const serialized: Record<string, Array<string>> = {}
	for (const topic of [...byTopic.keys()].sort((left, right) =>
		left.localeCompare(right),
	)) {
		serialized[topic] = [...(byTopic.get(topic) ?? [])].sort((left, right) =>
			left.localeCompare(right),
		)
	}
	return {
		version: packageSubscriptionTopicMapVersion,
		userId: input.userId,
		byTopic: serialized,
		cachedAt: new Date().toISOString(),
	}
}

export async function readPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}): Promise<PackageSubscriptionTopicMap | null> {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return null
	const raw = await kv.get(buildPackageSubscriptionTopicMapKey(input.userId), {
		type: 'json',
	})
	if (!isPackageSubscriptionTopicMap(raw, input.userId)) return null
	return raw
}

export async function writePackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	map: PackageSubscriptionTopicMap
}) {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return
	// No expirationTtl: a TTL could hide a newly published subscription.
	await kv.put(
		buildPackageSubscriptionTopicMapKey(input.map.userId),
		JSON.stringify(input.map),
	)
}

/**
 * Drop the cached map so the next wake cannot match a stale projection.
 * Prefer this before a rebuild when a publish/unpublish changes manifests.
 */
export async function invalidatePackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}) {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv || typeof kv.delete !== 'function') return
	await kv.delete(buildPackageSubscriptionTopicMapKey(input.userId))
}

/**
 * Delete-then-recompute: never leave wakes reading a map that predates this
 * publish/unpublish. If the rewrite fails after delete, the next wake fills
 * on miss.
 */
export async function refreshPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
}): Promise<PackageSubscriptionTopicMap | null> {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return null
	await invalidatePackageSubscriptionTopicMap(input)
	const map = await scanPackageSubscriptionTopicMap(input)
	await writePackageSubscriptionTopicMap({ env: input.env, map })
	return map
}

/**
 * Wake path: one KV get on hit; on miss, scan once, fill KV, return the map.
 */
export async function getOrFillPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
}): Promise<PackageSubscriptionTopicMap> {
	const cached = await readPackageSubscriptionTopicMap(input)
	if (cached) return cached
	const map = await scanPackageSubscriptionTopicMap(input)
	try {
		await writePackageSubscriptionTopicMap({ env: input.env, map })
	} catch (error) {
		console.warn('package-subscription-topic-map-write-failed', {
			userId: input.userId,
			error,
		})
	}
	return map
}

/**
 * Resolve candidate package ids for a topic from the per-user map (hit or
 * miss-fill). When KV is unavailable, returns null so callers can fall back to
 * a full uncached scan.
 */
export async function resolvePackageIdsForSubscriptionTopic(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
	topic: string
}): Promise<Array<string> | null> {
	if (!getSubscriptionTopicKv(input.env)) return null
	const map = await getOrFillPackageSubscriptionTopicMap(input)
	return map.byTopic[input.topic] ?? []
}

export async function listSavedPackagesForSubscriptionTopic(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
	topic: string
}): Promise<{
	savedPackages: Array<SavedPackageRecord>
	/**
	 * True when the topic map was consulted (hit or miss-fill). False when KV
	 * was unavailable and the caller must scan every saved package.
	 */
	usedTopicMap: boolean
}> {
	const packageIds = await resolvePackageIdsForSubscriptionTopic(input)
	if (packageIds === null) {
		return { savedPackages: [], usedTopicMap: false }
	}
	if (packageIds.length === 0) {
		return { savedPackages: [], usedTopicMap: true }
	}
	const savedPackages = await listSavedPackagesByIds(input.env.APP_DB, {
		userId: input.userId,
		packageIds,
	})
	return { savedPackages, usedTopicMap: true }
}

/**
 * Read the topic map when present. Returns `null` when KV is unavailable or
 * the key is missing — callers that need a fill should use
 * {@link getOrFillPackageSubscriptionTopicMap}.
 */
export async function tryReadPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}): Promise<PackageSubscriptionTopicMap | null> {
	if (!getSubscriptionTopicKv(input.env)) return null
	return await readPackageSubscriptionTopicMap(input)
}
