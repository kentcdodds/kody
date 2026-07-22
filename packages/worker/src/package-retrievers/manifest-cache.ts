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
	type PackageRetrieverIndexEntry,
	type PackageRetrieverScope,
	type PackageRetrieverManifestCacheEntry,
} from './types.ts'

const retrieverManifestCacheVersion = 1
const retrieverScopeIndexVersion = 1
const retrieverManifestCachePrefix = 'package-retriever-manifest'
const retrieverScopeEntryPrefix = 'package-retriever-index-entry'

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

function buildPackageRetrieverScopeEntryKey(input: {
	userId: string
	scope: PackageRetrieverScope
	packageId: string
	retrieverKey: string
}) {
	return [
		retrieverScopeEntryPrefix,
		`v${retrieverScopeIndexVersion}`,
		input.userId,
		input.scope,
		input.packageId,
		input.retrieverKey,
	].join(':')
}

function buildPackageRetrieverScopeEntryPrefix(input: {
	userId: string
	scope: PackageRetrieverScope
	packageId?: string
}) {
	return [
		retrieverScopeEntryPrefix,
		`v${retrieverScopeIndexVersion}`,
		input.userId,
		input.scope,
		...(input.packageId ? [input.packageId] : []),
		'',
	].join(':')
}

function buildPackageRetrieverManifestCachePrefix(input: {
	userId: string
	packageId: string
}) {
	return (
		[
			retrieverManifestCachePrefix,
			`v${retrieverManifestCacheVersion}`,
			input.userId,
			input.packageId,
		].join(':') + ':'
	)
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

async function writeScopeEntry(input: {
	env: Env
	scope: PackageRetrieverScope
	entry: PackageRetrieverIndexEntry
}) {
	await getRetrieverKv(input.env).put(
		buildPackageRetrieverScopeEntryKey({
			userId: input.entry.userId,
			scope: input.scope,
			packageId: input.entry.packageId,
			retrieverKey: input.entry.retrieverKey,
		}),
		JSON.stringify(input.entry),
	)
}

async function listScopeEntryKeys(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
	packageId?: string
}) {
	const kv = getRetrieverKv(input.env)
	const keys: Array<string> = []
	let cursor: string | undefined
	do {
		const result = await kv.list({
			prefix: buildPackageRetrieverScopeEntryPrefix({
				userId: input.userId,
				scope: input.scope,
				packageId: input.packageId,
			}),
			cursor,
		})
		keys.push(...result.keys.map((key) => key.name))
		cursor = result.list_complete ? undefined : result.cursor
	} while (cursor)
	return keys
}

async function listManifestCacheKeys(input: {
	env: Env
	userId: string
	packageId: string
}) {
	const kv = getRetrieverKv(input.env)
	const keys: Array<string> = []
	let cursor: string | undefined
	do {
		const result = await kv.list({
			prefix: buildPackageRetrieverManifestCachePrefix({
				userId: input.userId,
				packageId: input.packageId,
			}),
			cursor,
		})
		keys.push(...result.keys.map((key) => key.name))
		cursor = result.list_complete ? undefined : result.cursor
	} while (cursor)
	return keys
}

function isPackageRetrieverIndexEntry(
	entry: unknown,
): entry is PackageRetrieverIndexEntry {
	return (
		typeof entry === 'object' &&
		entry !== null &&
		'userId' in entry &&
		'packageId' in entry &&
		'kodyId' in entry &&
		typeof (entry as { kodyId?: unknown }).kodyId === 'string' &&
		'retrieverKey' in entry &&
		typeof (entry as { retrieverKey?: unknown }).retrieverKey === 'string' &&
		Array.isArray((entry as { scopes?: unknown }).scopes)
	)
}

function isPackageRetrieverManifestCacheEntry(
	entry: unknown,
): entry is PackageRetrieverManifestCacheEntry {
	return (
		typeof entry === 'object' &&
		entry !== null &&
		'retrieverKey' in entry &&
		typeof (entry as { retrieverKey?: unknown }).retrieverKey === 'string' &&
		Array.isArray((entry as { scopes?: unknown }).scopes)
	)
}

async function readScopeEntries(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
}) {
	const kv = getRetrieverKv(input.env)
	const entryKeys = await listScopeEntryKeys(input)
	const storedEntries = await Promise.all(
		entryKeys.map(async (key) => await kv.get(key, 'json')),
	)
	return storedEntries
		.filter(isPackageRetrieverIndexEntry)
		.filter(
			(entry) =>
				entry.userId === input.userId && entry.scopes.includes(input.scope),
		)
		.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.retrieverKey.localeCompare(right.retrieverKey),
		)
}

function toScopeIndexEntry(
	retriever: PackageRetrieverManifestCacheEntry,
): PackageRetrieverIndexEntry {
	return {
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
	}
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
	await deleteStaleManifestCacheKeys({
		env: input.env,
		userId: input.userId,
		packageId: input.savedPackage.id,
		currentManifestKey: manifestKey,
	})
	for (const scope of [
		'search',
		'context',
	] satisfies Array<PackageRetrieverScope>) {
		const existingScopeEntryKeys = await listScopeEntryKeys({
			env: input.env,
			userId: input.userId,
			scope,
			packageId: input.savedPackage.id,
		})
		const nextEntries = registeredRetrievers
			.filter((retriever) => retriever.scopes.includes(scope))
			.map(toScopeIndexEntry)
		const nextEntryKeys = new Set(
			nextEntries.map((entry) =>
				buildPackageRetrieverScopeEntryKey({
					userId: entry.userId,
					scope,
					packageId: entry.packageId,
					retrieverKey: entry.retrieverKey,
				}),
			),
		)
		await Promise.all([
			...existingScopeEntryKeys.map(async (key) => {
				if (!nextEntryKeys.has(key)) {
					await getRetrieverKv(input.env).delete(key)
				}
			}),
			...nextEntries.map((entry) =>
				writeScopeEntry({
					env: input.env,
					scope,
					entry,
				}),
			),
		])
	}
	return manifestCache
}

async function deleteStaleManifestCacheKeys(input: {
	env: Env
	userId: string
	packageId: string
	currentManifestKey: string
}) {
	try {
		const manifestCacheKeys = await listManifestCacheKeys(input)
		await Promise.all(
			manifestCacheKeys
				.filter((key) => key !== input.currentManifestKey)
				.map(async (key) => await getRetrieverKv(input.env).delete(key)),
		)
	} catch (error) {
		console.warn('package-retriever-stale-manifest-cleanup-failed', {
			userId: input.userId,
			packageId: input.packageId,
			error,
		})
	}
}

export async function removePackageRetrieverManifestCacheEntries(input: {
	env: Env
	userId: string
	packageId: string
}) {
	if (!hasRetrieverKv(input.env)) return
	const manifestCacheKeys = await listManifestCacheKeys(input)
	for (const scope of [
		'search',
		'context',
	] satisfies Array<PackageRetrieverScope>) {
		const existingScopeEntryKeys = await listScopeEntryKeys({
			env: input.env,
			userId: input.userId,
			scope,
			packageId: input.packageId,
		})
		await Promise.all(
			existingScopeEntryKeys.map(
				async (key) => await getRetrieverKv(input.env).delete(key),
			),
		)
	}
	await Promise.all(
		manifestCacheKeys.map(
			async (key) => await getRetrieverKv(input.env).delete(key),
		),
	)
}

export async function deleteAllPackageRetrieverCacheEntriesForUser(input: {
	env: Env
	userId: string
	packageIds: ReadonlyArray<string>
}) {
	if (!hasRetrieverKv(input.env)) return 0
	const keys = new Set<string>()
	for (const packageId of input.packageIds) {
		for (const key of await listManifestCacheKeys({
			env: input.env,
			userId: input.userId,
			packageId,
		})) {
			keys.add(key)
		}
		for (const scope of [
			'search',
			'context',
		] satisfies Array<PackageRetrieverScope>) {
			for (const key of await listScopeEntryKeys({
				env: input.env,
				userId: input.userId,
				scope,
				packageId,
			})) {
				keys.add(key)
			}
		}
	}
	const kv = getRetrieverKv(input.env)
	await Promise.all(Array.from(keys).map(async (key) => await kv.delete(key)))
	return keys.size
}

export async function listPackageRetrieversForScope(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
	limit?: number
}): Promise<Array<PackageRetrieverManifestCacheEntry>> {
	if (!hasRetrieverKv(input.env)) return []
	const references = await readScopeEntries(input)
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
				cached.revision !== reference.revision ||
				!Array.isArray(cached.retrievers)
			) {
				return []
			}
			return cached.retrievers.filter(
				(retriever): retriever is PackageRetrieverManifestCacheEntry =>
					isPackageRetrieverManifestCacheEntry(retriever) &&
					retriever.retrieverKey === reference.retrieverKey &&
					retriever.scopes.includes(input.scope),
			)
		}),
	)
	return manifests.flat().slice(0, input.limit ?? 10)
}
