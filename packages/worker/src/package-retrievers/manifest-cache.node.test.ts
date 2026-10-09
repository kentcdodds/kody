import { expect, test, vi } from 'vitest'
import {
	deleteAllPackageRetrieverCacheEntriesForUser,
	listPackageRetrieversForScope,
	refreshPackageRetrieverManifestCache,
	removePackageRetrieverManifestCacheEntries,
} from './manifest-cache.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

function createKv(pageSize = Number.POSITIVE_INFINITY) {
	const store = new Map<string, string>()
	const kv = {
		get: vi.fn(async (key: string, type?: 'json') => {
			const value = store.get(key) ?? null
			return type === 'json' && value ? JSON.parse(value) : value
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
		list: vi.fn(async (listOptions?: { prefix?: string; cursor?: string }) => {
			const matching = Array.from(store.keys())
				.filter((key) => key.startsWith(listOptions?.prefix ?? ''))
				.filter((key) => !listOptions?.cursor || key > listOptions.cursor)
				.sort()
			const page = matching.slice(0, pageSize)
			return {
				keys: page.map((name) => ({ name })),
				list_complete: page.length >= matching.length,
				...(page.length < matching.length ? { cursor: page.at(-1) } : {}),
			}
		}),
	} as unknown as KVNamespace
	return { store, kv }
}

function createSource(overrides?: Partial<EntitySourceRow>): EntitySourceRow {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
		...overrides,
	}
}

function createSavedPackage(
	overrides?: Partial<SavedPackageRecord>,
): SavedPackageRecord {
	return {
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/personal-inbox',
		kodyId: 'personal-inbox',
		description: 'Personal inbox package',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		lockedAt: null,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
		...overrides,
	}
}

const manifest = parseAuthoredPackageJson({
	content: JSON.stringify({
		name: '@kentcdodds/personal-inbox',
		exports: {
			'.': './src/index.ts',
			'./search-notes': './src/search-notes.ts',
		},
		kody: {
			id: 'personal-inbox',
			description: 'Personal inbox package',
			retrievers: {
				'notes-search': {
					export: './search-notes',
					name: 'Notes Search',
					description: 'Searches saved notes',
					scopes: ['search', 'context'],
					timeoutMs: 250,
					maxResults: 3,
				},
			},
		},
	}),
})

function createHarness() {
	const { kv, store } = createKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as Env
	return {
		kv,
		store,
		/** Refreshes `package-1` by default; pass `id` to cache another package on its own source. */
		refresh(input: { id?: string; commit?: string; kodyId?: string } = {}) {
			const id = input.id ?? 'package-1'
			const sourceId = id === 'package-1' ? 'source-1' : `source-${id}`
			return refreshPackageRetrieverManifestCache({
				env,
				userId: 'user-1',
				source: createSource({
					id: sourceId,
					published_commit: input.commit ?? 'commit-1',
				}),
				savedPackage: createSavedPackage({
					id,
					sourceId,
					...(input.kodyId
						? { kodyId: input.kodyId, name: `@kentcdodds/${input.kodyId}` }
						: {}),
				}),
				manifest,
			})
		},
		list(scope: 'search' | 'context', limit?: number) {
			return listPackageRetrieversForScope({
				env,
				userId: 'user-1',
				scope,
				limit,
			})
		},
		async listedPackageIds(scope: 'search' | 'context' = 'search') {
			return (await this.list(scope)).map((entry) => entry.packageId).sort()
		},
		remove(packageId: string) {
			return removePackageRetrieverManifestCacheEntries({
				env,
				userId: 'user-1',
				packageId,
			})
		},
		manifestKeys(packageId: string) {
			return Array.from(store.keys()).filter((key) =>
				key.startsWith(`package-retriever-manifest:v1:user-1:${packageId}:`),
			)
		},
	}
}

test('package retriever manifest cache refreshes, lists, removes entries, and preserves unrelated packages', async () => {
	const cache = createHarness()
	const indexKey =
		'package-retriever-index-entry:v1:user-1:search:package-1:notes-search'

	await cache.refresh()
	expect(cache.store.has(indexKey)).toBe(true)
	expect(cache.kv.put).toHaveBeenCalledWith(
		expect.stringContaining(
			'package-retriever-manifest:v1:user-1:package-1:commit-1',
		),
		expect.any(String),
	)
	await expect(cache.list('context')).resolves.toEqual([
		expect.objectContaining({
			kodyId: 'personal-inbox',
			retrieverKey: 'notes-search',
			exportName: './search-notes',
			entryPoint: 'src/search-notes.ts',
		}),
	])

	await cache.refresh()
	expect(cache.kv.delete).not.toHaveBeenCalledWith(indexKey)

	await cache.refresh({
		id: 'package-2',
		commit: 'commit-2',
		kodyId: 'other-inbox',
	})
	expect(await cache.listedPackageIds()).toEqual(['package-1', 'package-2'])

	await cache.remove('package-1')
	expect(await cache.listedPackageIds()).toEqual(['package-2'])
	expect(cache.manifestKeys('package-1')).toEqual([])
})

test('refreshing to a new revision deletes the stale manifest cache key', async () => {
	const cache = createHarness()
	await cache.refresh({ commit: 'commit-1' })
	await cache.refresh({ commit: 'commit-2' })

	expect(cache.manifestKeys('package-1')).toEqual([
		'package-retriever-manifest:v1:user-1:package-1:commit-2',
	])
	await expect(cache.list('search')).resolves.toEqual([
		expect.objectContaining({ packageId: 'package-1', revision: 'commit-2' }),
	])
})

test('listPackageRetrieversForScope filters stale, malformed, and prefix-colliding cache rows', async () => {
	const cache = createHarness()
	await cache.refresh({ id: 'package-stale', commit: 'commit-stale' })
	await cache.refresh()
	cache.store.delete(
		'package-retriever-manifest:v1:user-1:package-stale:commit-stale',
	)
	await expect(cache.list('search', 1)).resolves.toEqual([
		expect.objectContaining({
			packageId: 'package-1',
			retrieverKey: 'notes-search',
		}),
	])

	await cache.refresh({
		id: 'package-10',
		commit: 'commit-10',
		kodyId: 'package-10',
	})
	cache.store.set(
		'package-retriever-index-entry:v1:user-1:search:malformed:index',
		JSON.stringify({
			userId: 'user-1',
			packageId: 'malformed',
			retrieverKey: 'index',
			scopes: 'search',
		}),
	)
	cache.store.set(
		'package-retriever-index-entry:v1:user-1:search:bad-manifest:notes',
		JSON.stringify({
			userId: 'user-1',
			packageId: 'bad-manifest',
			kodyId: 'bad-manifest',
			packageName: '@kentcdodds/bad-manifest',
			sourceId: 'source-bad',
			revision: 'commit-bad',
			retrieverKey: 'notes',
			name: 'Bad',
			description: 'Bad manifest',
			scopes: ['search'],
		}),
	)
	cache.store.set(
		'package-retriever-manifest:v1:user-1:bad-manifest:commit-bad',
		JSON.stringify({
			version: 1,
			userId: 'user-1',
			packageId: 'bad-manifest',
			revision: 'commit-bad',
			retrievers: {},
		}),
	)
	expect(await cache.listedPackageIds()).toEqual(['package-1', 'package-10'])

	await cache.remove('package-1')
	expect(await cache.listedPackageIds()).toEqual(['package-10'])
})

test('account cleanup paginates user prefixes and removes historical package keys', async () => {
	const { kv, store } = createKv(1)
	store.set(
		'package-retriever-manifest:v1:user-1:removed-package:old-revision',
		'{}',
	)
	store.set(
		'package-retriever-index-entry:v1:user-1:search:removed-package:notes',
		'{}',
	)
	store.set('package-retriever-manifest:v1:user-2:other-package:revision', '{}')

	await expect(
		deleteAllPackageRetrieverCacheEntriesForUser({
			env: { BUNDLE_ARTIFACTS_KV: kv } as Env,
			userId: 'user-1',
		}),
	).resolves.toBe(2)
	expect([...store.keys()]).toEqual([
		'package-retriever-manifest:v1:user-2:other-package:revision',
	])
	expect(kv.list).toHaveBeenCalledWith(
		expect.objectContaining({
			prefix: 'package-retriever-manifest:v1:user-1:',
		}),
	)
})
