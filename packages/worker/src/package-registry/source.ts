import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	createPublishedPackageCacheKey,
	PromiseLruCache,
} from './published-package-cache.ts'
import { parseAuthoredPackageJson } from './manifest.ts'
import { type AuthoredPackageJson } from './types.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'

export type LoadedPackageSource = {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
	files: Record<string, string>
}

const packageSourceCache = new PromiseLruCache<LoadedPackageSource>()

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
	const source = input.source
	const freezeFiles = (files: Record<string, string>) =>
		Object.freeze({ ...files }) as Record<string, string>
	const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
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

	const finalizeLoadedSource = (loaded: {
		manifest: AuthoredPackageJson
		files: Record<string, string>
	}) =>
		Object.freeze({
			source: deepFreeze({ ...source }),
			manifest: deepFreeze(structuredClone(loaded.manifest)),
			files: freezeFiles(loaded.files),
		}) as LoadedPackageSource

	void input.baseUrl
	const published = await loadPublishedEntitySource({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
	})
	const manifestContent = published.files[source.manifest_path]
	if (!manifestContent) {
		throw new Error(
			`Saved package manifest "${source.manifest_path}" was not found in the repo source.`,
		)
	}
	return finalizeLoadedSource({
		manifest: parseAuthoredPackageJson({
			content: manifestContent,
			manifestPath: source.manifest_path,
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
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Saved package source "${input.sourceId}" was not found.`)
	}
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

	const cached = packageSourceCache.get(cacheKey)
	if (cached) {
		return await cached
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
