import { expect, test, vi } from 'vitest'
import {
	listPackageRetrieversForScope,
	refreshPackageRetrieverManifestCache,
	removePackageRetrieverManifestCacheEntries,
} from './manifest-cache.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

function createKv() {
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
		list: vi.fn(async (listOptions?: { prefix?: string; cursor?: string }) => ({
			keys: Array.from(store.keys())
				.filter((key) => key.startsWith(listOptions?.prefix ?? ''))
				.sort()
				.map((name) => ({ name })),
			list_complete: true,
			cursor: undefined,
		})),
	} as unknown as KVNamespace
	return {
		store,
		kv,
	}
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
		hidden: false,
		isPrivate: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
		...overrides,
	}
}

function createRetrieverManifest() {
	return parseAuthoredPackageJson({
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
}

test('package retriever manifest cache refreshes, lists, removes entries, and preserves unrelated packages', async () => {
	const { kv, store } = createKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as Env
	const manifest = createRetrieverManifest()

	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource(),
		savedPackage: createSavedPackage(),
		manifest,
	})

	expect(
		store.has(
			'package-retriever-index-entry:v1:user-1:search:package-1:notes-search',
		),
	).toBe(true)
	expect(kv.put).toHaveBeenCalledWith(
		expect.stringContaining(
			'package-retriever-manifest:v1:user-1:package-1:commit-1',
		),
		expect.any(String),
	)
	await expect(
		listPackageRetrieversForScope({
			env,
			userId: 'user-1',
			scope: 'context',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			kodyId: 'personal-inbox',
			retrieverKey: 'notes-search',
			exportName: './search-notes',
			entryPoint: 'src/search-notes.ts',
		}),
	])

	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource(),
		savedPackage: createSavedPackage(),
		manifest,
	})
	expect(kv.delete).not.toHaveBeenCalledWith(
		'package-retriever-index-entry:v1:user-1:search:package-1:notes-search',
	)

	const otherPackage = createSavedPackage({
		id: 'package-2',
		kodyId: 'other-inbox',
		name: '@kentcdodds/other-inbox',
		sourceId: 'source-2',
	})
	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource({ id: 'source-2', published_commit: 'commit-2' }),
		savedPackage: otherPackage,
		manifest,
	})

	const beforeRemoval = await listPackageRetrieversForScope({
		env,
		userId: 'user-1',
		scope: 'search',
	})
	expect(beforeRemoval).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ packageId: 'package-1' }),
			expect.objectContaining({ packageId: 'package-2' }),
		]),
	)
	expect(beforeRemoval).toHaveLength(2)

	await removePackageRetrieverManifestCacheEntries({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})

	await expect(
		listPackageRetrieversForScope({
			env,
			userId: 'user-1',
			scope: 'search',
		}),
	).resolves.toEqual([expect.objectContaining({ packageId: 'package-2' })])
	expect(
		Array.from(store.keys()).filter((key) =>
			key.startsWith('package-retriever-manifest:v1:user-1:package-1:'),
		),
	).toEqual([])
})

test('refreshing to a new revision deletes the stale manifest cache key', async () => {
	const { kv, store } = createKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as Env
	const manifest = createRetrieverManifest()

	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource({ published_commit: 'commit-1' }),
		savedPackage: createSavedPackage(),
		manifest,
	})
	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource({ published_commit: 'commit-2' }),
		savedPackage: createSavedPackage(),
		manifest,
	})

	expect(
		Array.from(store.keys()).filter((key) =>
			key.startsWith('package-retriever-manifest:v1:user-1:package-1:'),
		),
	).toEqual(['package-retriever-manifest:v1:user-1:package-1:commit-2'])
	await expect(
		listPackageRetrieversForScope({
			env,
			userId: 'user-1',
			scope: 'search',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			packageId: 'package-1',
			revision: 'commit-2',
		}),
	])
})

test('listPackageRetrieversForScope filters stale, malformed, and prefix-colliding cache rows', async () => {
	const { kv, store } = createKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as Env
	const manifest = createRetrieverManifest()

	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource({
			id: 'source-stale',
			published_commit: 'commit-stale',
		}),
		savedPackage: createSavedPackage({
			id: 'package-stale',
			sourceId: 'source-stale',
		}),
		manifest,
	})
	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource(),
		savedPackage: createSavedPackage(),
		manifest,
	})
	store.delete(
		'package-retriever-manifest:v1:user-1:package-stale:commit-stale',
	)

	await expect(
		listPackageRetrieversForScope({
			env,
			userId: 'user-1',
			scope: 'search',
			limit: 1,
		}),
	).resolves.toEqual([
		expect.objectContaining({
			packageId: 'package-1',
			retrieverKey: 'notes-search',
		}),
	])

	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource({
			id: 'source-10',
			published_commit: 'commit-10',
		}),
		savedPackage: createSavedPackage({
			id: 'package-10',
			kodyId: 'package-10',
			name: '@kentcdodds/package-10',
			sourceId: 'source-10',
		}),
		manifest,
	})

	await kv.put(
		'package-retriever-index-entry:v1:user-1:search:malformed:index',
		JSON.stringify({
			userId: 'user-1',
			packageId: 'malformed',
			retrieverKey: 'index',
			scopes: 'search',
		}),
	)
	await kv.put(
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
	store.set(
		'package-retriever-manifest:v1:user-1:bad-manifest:commit-bad',
		JSON.stringify({
			version: 1,
			userId: 'user-1',
			packageId: 'bad-manifest',
			revision: 'commit-bad',
			retrievers: {},
		}),
	)

	const listed = await listPackageRetrieversForScope({
		env,
		userId: 'user-1',
		scope: 'search',
	})
	expect(listed).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ packageId: 'package-1' }),
			expect.objectContaining({ packageId: 'package-10' }),
		]),
	)
	expect(listed).toHaveLength(2)

	await removePackageRetrieverManifestCacheEntries({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})

	await expect(
		listPackageRetrieversForScope({
			env,
			userId: 'user-1',
			scope: 'search',
		}),
	).resolves.toEqual([expect.objectContaining({ packageId: 'package-10' })])
})
