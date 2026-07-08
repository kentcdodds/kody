/**
 * KV-backed cache adapter for `@epic-web/cachified`, used for short-TTL
 * derived read models (for example the admin usage rollup page). Entries are
 * stored as JSON in `BUNDLE_ARTIFACTS_KV` under the documented key prefix
 * `derived-cache:v1:` and expire via KV `expirationTtl`, so no eviction code
 * is needed.
 *
 * All KV failures are swallowed: a broken cache must degrade to the direct
 * query, never break the read path. Callers own key uniqueness below the
 * prefix and must scope every key by user id(s) — cross-user data sharing is
 * a bug.
 */

import { totalTtl, type Cache, type CacheEntry } from '@epic-web/cachified'

export const derivedCacheKeyPrefix = 'derived-cache:v1:'

/** KV rejects expirationTtl values below 60 seconds. */
const minimumKvExpirationTtlSeconds = 60

export function createKvCachifiedCache(kv: KVNamespace): Cache {
	return {
		name: 'kv-derived-cache',
		async get(key) {
			try {
				return await kv.get<CacheEntry>(derivedCacheKeyPrefix + key, 'json')
			} catch (error) {
				console.debug('kv-cachified-get-failed', key, error)
				return null
			}
		},
		async set(key, entry) {
			try {
				const ttlMs = totalTtl(entry.metadata)
				const expirationTtl = Number.isFinite(ttlMs)
					? Math.max(Math.ceil(ttlMs / 1000), minimumKvExpirationTtlSeconds)
					: undefined
				await kv.put(derivedCacheKeyPrefix + key, JSON.stringify(entry), {
					expirationTtl,
				})
			} catch (error) {
				console.debug('kv-cachified-set-failed', key, error)
			}
		},
		async delete(key) {
			try {
				await kv.delete(derivedCacheKeyPrefix + key)
			} catch (error) {
				console.debug('kv-cachified-delete-failed', key, error)
			}
		},
	}
}
