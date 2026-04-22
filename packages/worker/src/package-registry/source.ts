import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	isLoopbackHostname,
	readMockArtifactSnapshot,
} from '#worker/repo/artifacts.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { loadRepoSourceFilesFromSession } from '#worker/repo/repo-codemode-execution.ts'
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
const packageManifestCache = new PromiseLruCache<LoadedPackageManifest>()

function canResolveRepoBackedPackageSource(env: Env) {
	const anyEnv = env as Env & { APP_DB?: unknown; REPO_SESSION?: unknown }
	return (
		anyEnv.APP_DB != null &&
		typeof anyEnv.APP_DB === 'object' &&
		anyEnv.REPO_SESSION != null &&
		typeof anyEnv.REPO_SESSION === 'object'
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

	const mockArtifactsBaseUrl = input.env.CLOUDFLARE_API_BASE_URL?.trim()
	if (mockArtifactsBaseUrl && source.published_commit) {
		const mockArtifactsUrl = new URL(mockArtifactsBaseUrl)
		if (isLoopbackHostname(mockArtifactsUrl.hostname)) {
			const snapshot = await readMockArtifactSnapshot({
				env: input.env,
				repoId: source.repo_id,
				commit: source.published_commit,
			})
			if (snapshot) {
				const manifestContent = snapshot.files[source.manifest_path]
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
					files: snapshot.files,
				})
			}
		}
	}
	const sessionId = `package-source-${source.id}-${crypto.randomUUID()}`
	const session = repoSessionRpc(input.env, sessionId)
	let openedSessionId: string | null = null
	try {
		const opened = await session.openSession({
			sessionId,
			sourceId: source.id,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: source.source_root,
		})
		openedSessionId = opened.id
		const manifestFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: source.manifest_path,
		})
		if (!manifestFile.content) {
			throw new Error(
				`Saved package manifest "${source.manifest_path}" was not found in the repo source.`,
			)
		}
		const manifest = parseAuthoredPackageJson({
			content: manifestFile.content,
			manifestPath: source.manifest_path,
		})
		const files = await loadRepoSourceFilesFromSession({
			sessionClient: session,
			sessionId: opened.id,
			userId: input.userId,
			sourceRoot: source.source_root,
		})
		files[source.manifest_path] = manifestFile.content
		return finalizeLoadedSource({
			manifest,
			files,
		})
	} finally {
		if (openedSessionId) {
			await session
				.discardSession({
					sessionId: openedSessionId,
					userId: input.userId,
				})
				.catch(() => {
					// Best effort only; source resolution should preserve the original error.
				})
		}
	}
}

async function loadPackageManifestUncached(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
}): Promise<LoadedPackageManifest> {
	const source = input.source
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

	const finalizeLoadedManifest = (loaded: {
		manifest: AuthoredPackageJson
	}) =>
		Object.freeze({
			source: deepFreeze({ ...source }),
			manifest: deepFreeze(structuredClone(loaded.manifest)),
		}) as LoadedPackageManifest

	const mockArtifactsBaseUrl = input.env.CLOUDFLARE_API_BASE_URL?.trim()
	if (mockArtifactsBaseUrl && source.published_commit) {
		const mockArtifactsUrl = new URL(mockArtifactsBaseUrl)
		if (isLoopbackHostname(mockArtifactsUrl.hostname)) {
			const snapshot = await readMockArtifactSnapshot({
				env: input.env,
				repoId: source.repo_id,
				commit: source.published_commit,
			})
			if (snapshot) {
				const manifestContent = snapshot.files[source.manifest_path]
				if (!manifestContent) {
					throw new Error(
						`Saved package manifest "${source.manifest_path}" was not found in the repo source.`,
					)
				}
				return finalizeLoadedManifest({
					manifest: parseAuthoredPackageJson({
						content: manifestContent,
						manifestPath: source.manifest_path,
					}),
				})
			}
		}
	}
	const sessionId = `package-manifest-${source.id}-${crypto.randomUUID()}`
	const session = repoSessionRpc(input.env, sessionId)
	let openedSessionId: string | null = null
	try {
		const opened = await session.openSession({
			sessionId,
			sourceId: source.id,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: source.source_root,
		})
		openedSessionId = opened.id
		const manifestFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: source.manifest_path,
		})
		if (!manifestFile.content) {
			throw new Error(
				`Saved package manifest "${source.manifest_path}" was not found in the repo source.`,
			)
		}
		return finalizeLoadedManifest({
			manifest: parseAuthoredPackageJson({
				content: manifestFile.content,
				manifestPath: source.manifest_path,
			}),
		})
	} finally {
		if (openedSessionId) {
			await session
				.discardSession({
					sessionId: openedSessionId,
					userId: input.userId,
				})
				.catch(() => {
					// Best effort only; source resolution should preserve the original error.
				})
		}
	}
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

export async function loadPackageManifestBySourceId(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
}): Promise<LoadedPackageManifest> {
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
		return await loadPackageManifestUncached({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			source,
		})
	}

	const cachedSource = packageSourceCache.get(cacheKey)
	if (cachedSource) {
		const loadedSource = await cachedSource
		return Object.freeze({
			source: loadedSource.source,
			manifest: loadedSource.manifest,
		}) as LoadedPackageManifest
	}

	const cachedManifest = packageManifestCache.get(cacheKey)
	if (cachedManifest) {
		return await cachedManifest
	}

	return await packageManifestCache.getOrCreate({
		cacheKey,
		create: async () =>
			await loadPackageManifestUncached({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				source,
			}),
	})
}
