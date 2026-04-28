import { expect, test, vi } from 'vitest'
import {
	buildPackageRetrieverScopeIndexKey,
	listPackageRetrieversForScope,
	refreshPackageRetrieverManifestCache,
	removePackageRetrieverManifestCacheEntries,
} from './manifest-cache.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
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
		} as unknown as KVNamespace,
	}
}

function createSource(): EntitySourceRow {
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
	}
}

function createSavedPackage(): SavedPackageRecord {
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
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	}
}

test('refreshPackageRetrieverManifestCache derives KV scope indexes from package metadata', async () => {
	const { kv, store } = createKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as Env
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

	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource(),
		savedPackage: createSavedPackage(),
		manifest,
	})

	const searchIndex = JSON.parse(
		store.get(
			buildPackageRetrieverScopeIndexKey({
				userId: 'user-1',
				scope: 'search',
			}),
		) ?? '{}',
	)
	expect(searchIndex.retrievers).toEqual([
		expect.objectContaining({
			packageId: 'package-1',
			retrieverKey: 'notes-search',
			revision: 'commit-1',
		}),
	])
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
})

test('removePackageRetrieverManifestCacheEntries removes package references from scope indexes', async () => {
	const { kv, store } = createKv()
	const env = { BUNDLE_ARTIFACTS_KV: kv } as Env
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
						scopes: ['search'],
					},
				},
			},
		}),
	})
	await refreshPackageRetrieverManifestCache({
		env,
		userId: 'user-1',
		source: createSource(),
		savedPackage: createSavedPackage(),
		manifest,
	})

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
	).resolves.toEqual([])
	const searchIndex = JSON.parse(
		store.get(
			buildPackageRetrieverScopeIndexKey({
				userId: 'user-1',
				scope: 'search',
			}),
		) ?? '{}',
	)
	expect(searchIndex.retrievers).toEqual([])
})
