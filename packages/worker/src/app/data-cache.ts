/**
 * Short-TTL in-isolate cache for **public, viewer-independent** server data.
 *
 * Trade-off: entries live only in the current worker isolate and expire after
 * `defaultTtlMs` (or sooner on explicit invalidation). That is ideal for
 * anonymous community listings — no cross-user leakage, no KV binding — but
 * cache hits are not shared across isolates or deploys. Production still
 * benefits from skipping repeated D1 reads within hot isolates.
 */

export type DataCacheLookup = 'hit' | 'miss'

type CacheEntry<T> = {
	value: T
	expiresAt: number
}

const defaultTtlMs = 60_000
const maxCacheEntries = 256

const store = new Map<string, CacheEntry<unknown>>()

let communityPublicCacheVersion = 0

export function getCommunityPublicCacheVersion() {
	return communityPublicCacheVersion
}

export function invalidateCommunityPublicCache() {
	communityPublicCacheVersion += 1
	store.clear()
}

export function buildCommunityIndexCacheKey(input: {
	query: string
	limit: number
}) {
	return `community-index:v${communityPublicCacheVersion}:q=${input.query}:limit=${input.limit}`
}

export function buildCommunityDetailListingCacheKey(listingId: string) {
	return `community-detail-listing:v${communityPublicCacheVersion}:id=${listingId}`
}

function sweepExpiredEntries(now = Date.now()) {
	for (const [key, entry] of store) {
		if (entry.expiresAt <= now) {
			store.delete(key)
		}
	}
}

function evictOldestEntry() {
	const oldestKey = store.keys().next().value
	if (oldestKey !== undefined) {
		store.delete(oldestKey)
	}
}

export function peekDataCache<T>(key: string): T | undefined {
	const entry = store.get(key)
	if (!entry) return undefined
	if (entry.expiresAt <= Date.now()) {
		store.delete(key)
		return undefined
	}
	return entry.value as T
}

export function setDataCache<T>(
	key: string,
	value: T,
	ttlMs: number = defaultTtlMs,
) {
	if (store.has(key)) {
		store.delete(key)
	}
	sweepExpiredEntries()
	store.set(key, {
		value,
		expiresAt: Date.now() + ttlMs,
	})
	while (store.size > maxCacheEntries) {
		evictOldestEntry()
	}
}

export async function getOrSetDataCache<T>(input: {
	key: string
	ttlMs?: number
	load: () => Promise<T>
}): Promise<{ value: T; lookup: DataCacheLookup }> {
	const cached = peekDataCache<T>(input.key)
	if (cached !== undefined) {
		return { value: cached, lookup: 'hit' }
	}

	const value = await input.load()
	setDataCache(input.key, value, input.ttlMs)
	return { value, lookup: 'miss' }
}

/** Test-only: reset module state between unit tests. */
export function resetDataCacheForTests() {
	communityPublicCacheVersion = 0
	store.clear()
}
