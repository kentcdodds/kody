import { snapshotStringToBytes } from '#universal/package-file-media.ts'
import {
	getPackageAppAssetsDirectory,
	getPackageAppClientEntryPath,
} from '#worker/package-registry/manifest.ts'
import {
	createPublishedPackageCacheKey,
	PromiseLruCache,
} from '#worker/package-registry/published-package-cache.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	buildKodyAppClientBundle,
	packageAppClientModuleNamePattern,
} from './module-graph-client-bundle.ts'
import {
	inferPackageAppAssetContentType,
	resolvePackageAppAssetSourcePath,
} from './package-app-assets-directory.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'

/**
 * Platform-served static surface of a hosted package app.
 *
 * Everything under `<appBasePath>/_assets/` is answered here before the
 * author's fetch handler runs:
 *
 * - `client.<hash>.js` — the browser ESM built from `kody.app.client`,
 *   served with immutable caching because the hash is in the URL.
 * - any other path — a file from the `kody.app.assets` directory, read from
 *   the published source snapshot and served as-is.
 */

const packageAppAssetsPathSegment = '_assets'
const packageAppAssetsPathPrefix = `/${packageAppAssetsPathSegment}/`
const clientModuleCacheControl = 'public, max-age=31536000, immutable'
const staticAssetCacheControl = 'public, max-age=300'

export type PackageAppClientArtifact = {
	mainModule: string
	modules: WorkerLoaderModules
}

type PackageAppAssetSavedPackage = {
	id: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
	manifestPath: string
	sourceRoot: string
}

const packageAppClientArtifactCache =
	new PromiseLruCache<PackageAppClientArtifact>()

/**
 * `/_assets/<relative>` → `<relative>` (percent-decoded), or `null` when the
 * request is not under the platform asset prefix.
 */
export function parsePackageAppAssetRequestPath(restPath: string) {
	if (!restPath.startsWith(packageAppAssetsPathPrefix)) return null
	const encoded = restPath.slice(packageAppAssetsPathPrefix.length)
	if (!encoded) return null
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

export function buildPackageAppAssetBasePath(appBasePath: string) {
	return `${appBasePath.replace(/\/+$/, '')}/${packageAppAssetsPathSegment}`
}

export function buildPackageAppClientModuleUrl(input: {
	hostedUrl: string
	mainModule: string
}) {
	return `${buildPackageAppAssetBasePath(input.hostedUrl)}/${input.mainModule}`
}

async function resolvePersistablePackageSource(input: {
	env: Env
	userId: string
	source?: EntitySourceRow
	sourceId: string
}) {
	if (input.source?.user_id === input.userId && input.source.repo_id) {
		return input.source
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Saved package source "${input.sourceId}" was not found.`)
	}
	return source
}

async function loadSourceFilesOrThrow(input: {
	sourceFiles?: Record<string, string>
	loadSourceFiles?: () => Promise<Record<string, string>>
}) {
	if (input.sourceFiles) return input.sourceFiles
	if (!input.loadSourceFiles) {
		throw new Error(
			'Saved package source files are required to build the app client bundle.',
		)
	}
	return await input.loadSourceFiles()
}

async function resolvePackageAppClientArtifactUncached(input: {
	env: Env
	userId: string
	clientEntry: string
	source?: EntitySourceRow
	savedPackage: PackageAppAssetSavedPackage
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
}): Promise<PackageAppClientArtifact> {
	if (input.savedPackage.publishedCommit) {
		const loaded = await loadPublishedBundleArtifactByIdentity({
			env: input.env,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
			kind: 'app-client',
			artifactName: null,
			entryPoint: input.clientEntry,
		})
		if (loaded?.artifact) {
			return {
				mainModule: loaded.artifact.mainModule,
				modules: loaded.artifact.modules,
			}
		}
	}
	const sourceFiles = await loadSourceFilesOrThrow(input)
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles,
		bundleLabel: `Saved package app client "${input.savedPackage.kodyId}"`,
	})
	const compiled = await buildKodyAppClientBundle({
		sourceFiles,
		entryPoint: input.clientEntry,
	})
	if (input.savedPackage.publishedCommit) {
		// Publish normally persists this artifact; a miss here means a rebuild
		// was interrupted, so repair it the same way the Worker bundle does.
		const persistableSource = await resolvePersistablePackageSource({
			env: input.env,
			userId: input.userId,
			source: input.source,
			sourceId: input.savedPackage.sourceId,
		})
		await persistPublishedBundleArtifact({
			env: input.env,
			userId: input.userId,
			source: persistableSource,
			kind: 'app-client',
			artifactName: null,
			entryPoint: input.clientEntry,
			mainModule: compiled.mainModule,
			modules: compiled.modules,
			dependencies: compiled.dependencies,
			dynamicDependencies: compiled.dynamicDependencies,
			packageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
			},
		})
	}
	return { mainModule: compiled.mainModule, modules: compiled.modules }
}

/**
 * The published browser bundle for `kody.app.client`, or `null` when the
 * manifest declares no client. Cached per (user, source, commit) so warm
 * serves and worker-option builds share one KV read.
 */
export async function resolvePackageAppClientArtifact(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	source?: EntitySourceRow
	savedPackage: PackageAppAssetSavedPackage
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
}): Promise<PackageAppClientArtifact | null> {
	const clientEntry = getPackageAppClientEntryPath(input.manifest)
	if (!clientEntry) return null
	const cacheKey = createPublishedPackageCacheKey({
		userId: input.userId,
		source: {
			id: input.savedPackage.sourceId,
			published_commit: input.savedPackage.publishedCommit,
			manifest_path: input.savedPackage.manifestPath,
			source_root: input.savedPackage.sourceRoot,
		},
		entryPoint: `app-client:${clientEntry}`,
	})
	const create = () =>
		resolvePackageAppClientArtifactUncached({ ...input, clientEntry })
	if (!cacheKey) return await create()
	return await packageAppClientArtifactCache.getOrCreate({ cacheKey, create })
}

function methodNotAllowed() {
	return new Response('Method not allowed', {
		status: 405,
		headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
	})
}

function assetNotFound() {
	return new Response('Not found', {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function createAssetResponse(input: {
	request: Request
	body: Uint8Array | string
	contentType: string
	cacheControl: string
	etag: string | null
}) {
	const headers = new Headers({
		'Cache-Control': input.cacheControl,
		'Content-Type': input.contentType,
		'X-Content-Type-Options': 'nosniff',
	})
	if (input.etag) {
		headers.set('ETag', input.etag)
		if (input.request.headers.get('If-None-Match') === input.etag) {
			return new Response(null, { status: 304, headers })
		}
	}
	// Both producers allocate a fresh ArrayBuffer-backed view, so this is a
	// type narrowing, not a copy of a possibly multi-megabyte asset.
	const bytes = (
		typeof input.body === 'string'
			? new TextEncoder().encode(input.body)
			: input.body
	) as Uint8Array<ArrayBuffer>
	headers.set('Content-Length', String(bytes.byteLength))
	return new Response(input.request.method === 'HEAD' ? null : bytes, {
		status: 200,
		headers,
	})
}

function readModuleSource(module: WorkerLoaderModules[string] | undefined) {
	if (typeof module === 'string') return module
	if (typeof module?.js === 'string') return module.js
	return null
}

/**
 * Answer one `/_assets/<relativePath>` request for the owner's hosted app.
 * The caller has already authenticated the owner and resolved the saved
 * package; this only decides between the client bundle, a static asset, and
 * 404.
 */
export async function servePackageAppAssetRequest(input: {
	request: Request
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	source?: EntitySourceRow
	savedPackage: PackageAppAssetSavedPackage
	loadSourceFiles: () => Promise<Record<string, string>>
	relativePath: string
}) {
	if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
		return methodNotAllowed()
	}
	if (packageAppClientModuleNamePattern.test(input.relativePath)) {
		const artifact = await resolvePackageAppClientArtifact(input)
		const source = artifact
			? readModuleSource(artifact.modules[artifact.mainModule])
			: null
		if (
			!artifact ||
			source == null ||
			input.relativePath !== artifact.mainModule
		) {
			// A stale hash from a previous publish; the page must re-read
			// packageContext.clientModuleUrl rather than get a wrong module.
			return assetNotFound()
		}
		return createAssetResponse({
			request: input.request,
			body: source,
			contentType: 'text/javascript; charset=utf-8',
			cacheControl: clientModuleCacheControl,
			etag: `"${artifact.mainModule}"`,
		})
	}
	const assetsDirectory = getPackageAppAssetsDirectory(input.manifest)
	if (!assetsDirectory) return assetNotFound()
	const sourcePath = resolvePackageAppAssetSourcePath({
		assetsDirectory,
		relativePath: input.relativePath,
	})
	if (!sourcePath) return assetNotFound()
	const sourceFiles = await input.loadSourceFiles()
	const content = sourceFiles[sourcePath]
	if (content == null) return assetNotFound()
	const publishedCommit = input.savedPackage.publishedCommit
	return createAssetResponse({
		request: input.request,
		body: snapshotStringToBytes(content, sourcePath),
		contentType: inferPackageAppAssetContentType(sourcePath),
		// The published snapshot is immutable per commit, so the commit plus
		// path is a strong validator without hashing the bytes per request.
		cacheControl: publishedCommit ? staticAssetCacheControl : 'no-store',
		etag: publishedCommit
			? `"${publishedCommit}:${sourcePath.replaceAll('"', '_')}"`
			: null,
	})
}
