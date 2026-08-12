import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type PublishedBundleArtifact } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

/**
 * Per-isolate caches for invocation hot paths (`packages.invoke` contract
 * check and package-app HTTP serve), so a warm call of an already-warm
 * package+commit performs zero D1/KV loads before dispatch (see
 * docs/contributing/architecture/invocation-overhead-guardrails.md).
 *
 * Two tiers with different lifetimes:
 *
 * - **Freshness tier** (saved-package row, entity-source row): these rows can
 *   change on republish/rename, so they carry a short TTL. That TTL is the
 *   cross-isolate republish staleness bound; the isolate that runs the
 *   projection refresh also invalidates eagerly, so it picks the new publish
 *   up immediately. Misses are never retained — a package saved moments later
 *   is visible on the next lookup.
 * - **Commit tier** (prepared bundle artifact): keyed by the published commit
 *   taken from the freshness tier, and a published commit's artifact is
 *   immutable, so entries here are never a staleness source. The TTL only
 *   bounds memory.
 *
 * Every cache key starts with the caller's `userId`; entries are never shared
 * across users.
 */

/**
 * Cross-isolate republish staleness bound for invocation paths: after
 * `entity_sources.published_commit` (or the saved-package row) changes, other
 * isolates serve the previous contract for at most this long.
 */
export const invokeContractFreshnessTtlMs = 15_000
export const invokeContractFreshnessCacheLimit = 200

/**
 * Commit-keyed artifact entries are immutable; this TTL and the small limit
 * exist only to bound isolate memory (bundle payloads can be large).
 */
export const invokeContractArtifactCacheTtlMs = 5 * 60 * 1000
export const invokeContractArtifactCacheLimit = 20

export type CachedInvokeModuleArtifact = {
	artifact: PublishedBundleArtifact
	source: EntitySourceRow
	entryPoint: string
}

function createFreshnessCache<T>() {
	return new PromiseLruCache<T>({
		ttlMs: invokeContractFreshnessTtlMs,
		limit: invokeContractFreshnessCacheLimit,
	})
}

function createArtifactCache() {
	return new PromiseLruCache<CachedInvokeModuleArtifact>({
		ttlMs: invokeContractArtifactCacheTtlMs,
		limit: invokeContractArtifactCacheLimit,
	})
}

let savedPackageCache = createFreshnessCache<SavedPackageRecord | null>()
let sourceRowCache = createFreshnessCache<EntitySourceRow>()
let moduleArtifactCache = createArtifactCache()

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === 'object') {
		const objectValue = value as object
		if (seen.has(objectValue)) {
			return value
		}
		seen.add(objectValue)
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child, seen)
		}
		Object.freeze(objectValue)
	}
	return value
}

function savedPackageCacheKey(input: {
	userId: string
	packageIdOrKodyId: string
}) {
	return JSON.stringify([
		'saved-package',
		input.userId,
		input.packageIdOrKodyId,
	])
}

function sourceRowCacheKey(input: { userId: string; sourceId: string }) {
	return JSON.stringify(['source-row', input.userId, input.sourceId])
}

export async function resolveSavedPackageWithFreshnessCache(input: {
	userId: string
	packageIdOrKodyId: string
	load: () => Promise<SavedPackageRecord | null>
}): Promise<SavedPackageRecord | null> {
	const cacheKey = savedPackageCacheKey(input)
	return await savedPackageCache.getOrCreate({
		cacheKey,
		create: async () => {
			const record = await input.load()
			if (!record) {
				// Do not retain misses: a package saved moments later must be
				// visible on the next lookup instead of after the TTL.
				savedPackageCache.delete(cacheKey)
				return null
			}
			return deepFreeze(record)
		},
	})
}

export async function loadSourceRowWithFreshnessCache(input: {
	userId: string
	sourceId: string
	load: () => Promise<EntitySourceRow>
}): Promise<EntitySourceRow> {
	return await sourceRowCache.getOrCreate({
		cacheKey: sourceRowCacheKey(input),
		create: async () => deepFreeze(await input.load()),
	})
}

export async function loadModuleArtifactWithCommitCache(input: {
	userId: string
	sourceId: string
	publishedCommit: string | null
	artifactName: string
	entryPoint: string
	load: () => Promise<CachedInvokeModuleArtifact>
}): Promise<CachedInvokeModuleArtifact> {
	if (!input.publishedCommit) {
		return await input.load()
	}
	const cacheKey = JSON.stringify([
		'module-artifact',
		input.userId,
		input.sourceId,
		input.publishedCommit,
		input.artifactName,
		input.entryPoint,
	])
	return await moduleArtifactCache.getOrCreate({
		cacheKey,
		create: async () => {
			const value = await input.load()
			if (value.artifact.publishedCommit !== input.publishedCommit) {
				// The bundle-artifact identity row can briefly point at a different
				// commit than the source row (e.g. mid-republish). Serve it, but do
				// not retain it under this commit's key — retaining would extend
				// staleness past the freshness-tier TTL.
				moduleArtifactCache.delete(cacheKey)
				return value
			}
			return deepFreeze(value)
		},
	})
}

/**
 * Eager same-isolate invalidation for publish / projection-refresh / delete
 * flows. Cross-isolate pickup is bounded by
 * {@link invokeContractFreshnessTtlMs}. The commit-tier artifact cache needs
 * no invalidation: a republish changes the commit and therefore the key.
 */
export function invalidateInvokeContractFreshness(input: {
	userId: string
	/**
	 * Every lookup key the package resolves under: its package id plus any
	 * current (and, on rename, previous) kody ids.
	 */
	packageIdOrKodyIds: Array<string>
	sourceId?: string | null
}) {
	for (const packageIdOrKodyId of input.packageIdOrKodyIds) {
		savedPackageCache.delete(
			savedPackageCacheKey({ userId: input.userId, packageIdOrKodyId }),
		)
	}
	if (input.sourceId) {
		sourceRowCache.delete(
			sourceRowCacheKey({ userId: input.userId, sourceId: input.sourceId }),
		)
	}
}

export function clearInvokeContractCachesForTests() {
	savedPackageCache = createFreshnessCache<SavedPackageRecord | null>()
	sourceRowCache = createFreshnessCache<EntitySourceRow>()
	moduleArtifactCache = createArtifactCache()
}
