import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'
import {
	createPublishedPackageCacheKey,
	PromiseLruCache,
} from './published-package-cache.ts'
import { parseAuthoredPackageJson } from './manifest.ts'
import { type AuthoredPackageJson } from './types.ts'

export type LoadedPackageSource = {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
	files: Record<string, string>
}

export type LoadedPackageManifest = {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
}

const packageSourceCache = new PromiseLruCache<LoadedPackageSource>()

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

function freezeFiles(files: Record<string, string>) {
	return Object.freeze({ ...files }) as Record<string, string>
}

function finalizeLoadedSource(input: {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
	files: Record<string, string>
}) {
	return Object.freeze({
		source: deepFreeze({ ...input.source }),
		manifest: deepFreeze(structuredClone(input.manifest)),
		files: freezeFiles(input.files),
	}) as LoadedPackageSource
}

function deriveLoadedManifest(
	loadedSource: LoadedPackageSource,
): LoadedPackageManifest {
	return Object.freeze({
		source: loadedSource.source,
		manifest: loadedSource.manifest,
	}) as LoadedPackageManifest
}

function parsePackageManifest(input: {
	source: EntitySourceRow
	content: string
}) {
	return parseAuthoredPackageJson({
		content: input.content,
		manifestPath: input.source.manifest_path,
	})
}

function getManifestContent(input: {
	source: EntitySourceRow
	files: Record<string, string>
}) {
	const manifestContent = input.files[input.source.manifest_path]
	if (!manifestContent) {
		throw new Error(
			`Saved package manifest "${input.source.manifest_path}" was not found in the repo source.`,
		)
	}
	return manifestContent
}

function canResolveRepoBackedPackageSource(env: Env) {
	const anyEnv = env as Env & {
		APP_DB?: unknown
		BUNDLE_ARTIFACTS_KV?: unknown
	}
	return (
		anyEnv.APP_DB != null &&
		typeof anyEnv.APP_DB === 'object' &&
		anyEnv.BUNDLE_ARTIFACTS_KV != null &&
		typeof anyEnv.BUNDLE_ARTIFACTS_KV === 'object'
	)
}

async function resolvePackageSourceRow(input: {
	env: Env
	userId: string
	sourceId: string
}) {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Saved package source "${input.sourceId}" was not found.`)
	}
	return source
}

function createPackageSourceCacheKey(input: {
	userId: string
	source: EntitySourceRow
}) {
	return createPublishedPackageCacheKey({
		userId: input.userId,
		source: input.source,
	})
}

async function loadPackageSourceUncached(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
}): Promise<LoadedPackageSource> {
	void input.baseUrl
	const published = await loadPublishedEntitySource({
		env: input.env,
		userId: input.userId,
		sourceId: input.source.id,
	})
	return finalizeLoadedSource({
		source: input.source,
		manifest: parsePackageManifest({
			source: input.source,
			content: getManifestContent({
				source: input.source,
				files: published.files,
			}),
		}),
		files: published.files,
	})
}

export async function loadPackageSourceBySourceId(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
}): Promise<LoadedPackageSource> {
	if (!canResolveRepoBackedPackageSource(input.env)) {
		throw new Error('Saved package source bindings are not available.')
	}
	const source = await resolvePackageSourceRow({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	const cacheKey = createPackageSourceCacheKey({
		userId: input.userId,
		source,
	})
	if (!cacheKey) {
		return await loadPackageSourceUncached({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			source,
		})
	}
	return await packageSourceCache.getOrCreate({
		cacheKey,
		create: async () =>
			await loadPackageSourceUncached({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				source,
			}),
	})
}

export async function loadPackageManifestBySourceId(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
}): Promise<LoadedPackageManifest> {
	if (!canResolveRepoBackedPackageSource(input.env)) {
		throw new Error('Saved package source bindings are not available.')
	}
	const source = await resolvePackageSourceRow({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	const cacheKey = createPackageSourceCacheKey({
		userId: input.userId,
		source,
	})
	if (!cacheKey) {
		return deriveLoadedManifest(
			await loadPackageSourceUncached({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				source,
			}),
		)
	}
	return deriveLoadedManifest(
		await packageSourceCache.getOrCreate({
			cacheKey,
			create: async () =>
				await loadPackageSourceUncached({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					source,
				}),
		}),
	)
}
