import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	listPackageRetrievers,
	resolvePackageExportPath,
	type PackageRetrieverManifestEntry,
} from '#worker/package-registry/manifest.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	type PackageRetrieverManifestCache,
	type PackageRetrieverScope,
	type PackageRetrieverScopeIndex,
	type PackageRetrieverManifestCacheEntry,
} from './types.ts'

const retrieverManifestCacheVersion = 1
const retrieverScopeIndexVersion = 1
const retrieverManifestCachePrefix = 'package-retriever-manifest'
const retrieverScopeIndexPrefix = 'package-retriever-index'

function getRetrieverKv(env: Env) {
	const kv = (env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error(
			'Missing BUNDLE_ARTIFACTS_KV binding for package retrievers.',
		)
	}
	return kv
}

function hasRetrieverKv(env: Env) {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV != null
	)
}

function normalizeRevision(source: EntitySourceRow) {
	if (!source.published_commit) {
		throw new Error(
			`Saved package source "${source.id}" must have a published commit before retrievers can be indexed.`,
		)
	}
	return source.published_commit
}

function buildManifestHash(input: {
	kodyId: string
	revision: string
	retrievers: Array<PackageRetrieverManifestEntry>
}) {
	return JSON.stringify({
		kodyId: input.kodyId,
		revision: input.revision,
		retrievers: input.retrievers,
	})
}

export function buildPackageRetrieverManifestCacheKey(input: {
	userId: string
	packageId: string
	revision: string
}) {
	return [
		retrieverManifestCachePrefix,
		`v${retrieverManifestCacheVersion}`,
		input.userId,
		input.packageId,
		input.revision,
	].join(':')
}

export function buildPackageRetrieverScopeIndexKey(input: {
	userId: string
	scope: PackageRetrieverScope
}) {
	return [
		retrieverScopeIndexPrefix,
		`v${retrieverScopeIndexVersion}`,
		input.userId,
		input.scope,
	].join(':')
}

function toRegisteredRetriever(input: {
	savedPackage: SavedPackageRecord
	source: EntitySourceRow
	revision: string
	retriever: PackageRetrieverManifestEntry
	manifest: AuthoredPackageJson
}): PackageRetrieverManifestCacheEntry {
	return {
		userId: input.savedPackage.userId,
		packageId: input.savedPackage.id,
		kodyId: input.savedPackage.kodyId,
		packageName: input.savedPackage.name,
		sourceId: input.source.id,
		revision: input.revision,
		retrieverKey: input.retriever.key,
		exportName: input.retriever.exportName,
		entryPoint: resolvePackageExportPath({
			manifest: input.manifest,
			exportName: input.retriever.exportName,
		}),
		name: input.retriever.name,
		description: input.retriever.description,
		scopes: input.retriever.scopes,
		timeoutMs: input.retriever.timeoutMs,
		maxResults: input.retriever.maxResults,
	}
}

async function readScopeIndex(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
}): Promise<PackageRetrieverScopeIndex> {
	const key = buildPackageRetrieverScopeIndexKey({
		userId: input.userId,
		scope: input.scope,
	})
	const stored = await getRetrieverKv(input.env).get(key, 'json')
	if (!stored || typeof stored !== 'object') {
		return {
			version: retrieverScopeIndexVersion,
			userId: input.userId,
			scope: input.scope,
			retrievers: [],
			updatedAt: new Date().toISOString(),
		}
	}
	const index = stored as PackageRetrieverScopeIndex
	if (
		index.version !== retrieverScopeIndexVersion ||
		index.userId !== input.userId ||
		index.scope !== input.scope ||
		!Array.isArray(index.retrievers)
	) {
		return {
			version: retrieverScopeIndexVersion,
			userId: input.userId,
			scope: input.scope,
			retrievers: [],
			updatedAt: new Date().toISOString(),
		}
	}
	return index
}

async function writeScopeIndex(input: {
	env: Env
	index: PackageRetrieverScopeIndex
}) {
	const key = buildPackageRetrieverScopeIndexKey({
		userId: input.index.userId,
		scope: input.index.scope,
	})
	await getRetrieverKv(input.env).put(key, JSON.stringify(input.index))
}

export async function refreshPackageRetrieverManifestCache(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	savedPackage: SavedPackageRecord
	manifest: AuthoredPackageJson
}) {
	if (!hasRetrieverKv(input.env)) return null
	const revision = normalizeRevision(input.source)
	const retrievers = listPackageRetrievers(input.manifest)
	const registeredRetrievers = retrievers.map((retriever) =>
		toRegisteredRetriever({
			savedPackage: input.savedPackage,
			source: input.source,
			revision,
			retriever,
			manifest: input.manifest,
		}),
	)
	const manifestCache: PackageRetrieverManifestCache = {
		version: retrieverManifestCacheVersion,
		userId: input.userId,
		packageId: input.savedPackage.id,
		kodyId: input.savedPackage.kodyId,
		packageName: input.savedPackage.name,
		sourceId: input.source.id,
		revision,
		manifestHash: buildManifestHash({
			kodyId: input.savedPackage.kodyId,
			revision,
			retrievers,
		}),
		retrievers: registeredRetrievers,
		cachedAt: new Date().toISOString(),
	}
	const manifestKey = buildPackageRetrieverManifestCacheKey({
		userId: input.userId,
		packageId: input.savedPackage.id,
		revision,
	})
	await getRetrieverKv(input.env).put(
		manifestKey,
		JSON.stringify(manifestCache),
	)
	for (const scope of [
		'search',
		'context',
	] satisfies Array<PackageRetrieverScope>) {
		const existing = await readScopeIndex({
			env: input.env,
			userId: input.userId,
			scope,
		})
		const nextRetrievers = [
			...existing.retrievers.filter(
				(entry) => entry.packageId !== input.savedPackage.id,
			),
			...registeredRetrievers
				.filter((retriever) => retriever.scopes.includes(scope))
				.map((retriever) => ({
					userId: retriever.userId,
					packageId: retriever.packageId,
					kodyId: retriever.kodyId,
					packageName: retriever.packageName,
					sourceId: retriever.sourceId,
					revision: retriever.revision,
					retrieverKey: retriever.retrieverKey,
					name: retriever.name,
					description: retriever.description,
					scopes: retriever.scopes,
				})),
		].sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.retrieverKey.localeCompare(right.retrieverKey),
		)
		await writeScopeIndex({
			env: input.env,
			index: {
				version: retrieverScopeIndexVersion,
				userId: input.userId,
				scope,
				retrievers: nextRetrievers,
				updatedAt: new Date().toISOString(),
			},
		})
	}
	return manifestCache
}

export async function removePackageRetrieverManifestCacheEntries(input: {
	env: Env
	userId: string
	packageId: string
}) {
	if (!hasRetrieverKv(input.env)) return
	for (const scope of [
		'search',
		'context',
	] satisfies Array<PackageRetrieverScope>) {
		const existing = await readScopeIndex({
			env: input.env,
			userId: input.userId,
			scope,
		})
		const nextRetrievers = existing.retrievers.filter(
			(entry) => entry.packageId !== input.packageId,
		)
		if (nextRetrievers.length === existing.retrievers.length) continue
		await writeScopeIndex({
			env: input.env,
			index: {
				...existing,
				retrievers: nextRetrievers,
				updatedAt: new Date().toISOString(),
			},
		})
	}
}

export async function listPackageRetrieversForScope(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
	limit?: number
}): Promise<Array<PackageRetrieverManifestCacheEntry>> {
	if (!hasRetrieverKv(input.env)) return []
	const index = await readScopeIndex({
		env: input.env,
		userId: input.userId,
		scope: input.scope,
	})
	const references = index.retrievers.slice(0, input.limit ?? 10)
	const manifests = await Promise.all(
		references.map(async (reference) => {
			const manifest = await getRetrieverKv(input.env).get(
				buildPackageRetrieverManifestCacheKey({
					userId: input.userId,
					packageId: reference.packageId,
					revision: reference.revision,
				}),
				'json',
			)
			if (!manifest || typeof manifest !== 'object') return []
			const cached = manifest as PackageRetrieverManifestCache
			if (
				cached.version !== retrieverManifestCacheVersion ||
				cached.userId !== input.userId ||
				cached.packageId !== reference.packageId ||
				cached.revision !== reference.revision
			) {
				return []
			}
			return cached.retrievers.filter(
				(retriever) =>
					retriever.retrieverKey === reference.retrieverKey &&
					retriever.scopes.includes(input.scope),
			)
		}),
	)
	return manifests.flat()
}
