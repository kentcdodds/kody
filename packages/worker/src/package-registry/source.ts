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

function finalizeLoadedManifest(input: {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
}) {
	return Object.freeze({
		source: deepFreeze({ ...input.source }),
		manifest: deepFreeze(structuredClone(input.manifest)),
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

async function readManifestFromMockSnapshot(input: {
	env: Env
	source: EntitySourceRow
}): Promise<
	| {
			manifest: AuthoredPackageJson
			manifestContent: string
			files: Record<string, string>
	  }
	| null
> {
	const mockArtifactsBaseUrl = input.env.CLOUDFLARE_API_BASE_URL?.trim()
	if (!mockArtifactsBaseUrl || !input.source.published_commit) {
		return null
	}
	const mockArtifactsUrl = new URL(mockArtifactsBaseUrl)
	if (!isLoopbackHostname(mockArtifactsUrl.hostname)) {
		return null
	}
	const snapshot = await readMockArtifactSnapshot({
		env: input.env,
		repoId: input.source.repo_id,
		commit: input.source.published_commit,
	})
	if (!snapshot) {
		return null
	}
	const manifestContent = snapshot.files[input.source.manifest_path]
	if (!manifestContent) {
		throw new Error(
			`Saved package manifest "${input.source.manifest_path}" was not found in the repo source.`,
		)
	}
	return {
		manifest: parsePackageManifest({
			source: input.source,
			content: manifestContent,
		}),
		manifestContent,
		files: snapshot.files,
	}
}

async function withPackageManifestSession<T>(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
	sessionPrefix: string
	run: (resolved: {
		session: ReturnType<typeof repoSessionRpc>
		sessionId: string
		manifest: AuthoredPackageJson
		manifestContent: string
	}) => Promise<T>
}): Promise<T> {
	const sessionId = `${input.sessionPrefix}-${input.source.id}-${crypto.randomUUID()}`
	const session = repoSessionRpc(input.env, sessionId)
	let openedSessionId: string | null = null
	try {
		const opened = await session.openSession({
			sessionId,
			sourceId: input.source.id,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: input.source.source_root,
		})
		openedSessionId = opened.id
		const manifestFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: input.source.manifest_path,
		})
		if (!manifestFile.content) {
			throw new Error(
				`Saved package manifest "${input.source.manifest_path}" was not found in the repo source.`,
			)
		}
		return await input.run({
			session,
			sessionId: opened.id,
			manifest: parsePackageManifest({
				source: input.source,
				content: manifestFile.content,
			}),
			manifestContent: manifestFile.content,
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
	const snapshot = await readManifestFromMockSnapshot({
		env: input.env,
		source: input.source,
	})
	if (snapshot) {
		return finalizeLoadedSource({
			source: input.source,
			manifest: snapshot.manifest,
			files: snapshot.files,
		})
	}
	return await withPackageManifestSession({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		source: input.source,
		sessionPrefix: 'package-source',
		run: async ({ session, sessionId, manifest, manifestContent }) => {
			const files = await loadRepoSourceFilesFromSession({
				sessionClient: session,
				sessionId,
				userId: input.userId,
				sourceRoot: input.source.source_root,
			})
			files[input.source.manifest_path] = manifestContent
			return finalizeLoadedSource({
				source: input.source,
				manifest,
				files,
			})
		},
	})
}

async function loadPackageManifestUncached(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
}): Promise<LoadedPackageManifest> {
	const snapshot = await readManifestFromMockSnapshot({
		env: input.env,
		source: input.source,
	})
	if (snapshot) {
		return finalizeLoadedManifest({
			source: input.source,
			manifest: snapshot.manifest,
		})
	}
	return await withPackageManifestSession({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		source: input.source,
		sessionPrefix: 'package-manifest',
		run: async ({ manifest }) =>
			finalizeLoadedManifest({
				source: input.source,
				manifest,
			}),
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
