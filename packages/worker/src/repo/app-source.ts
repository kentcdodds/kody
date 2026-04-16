import { type UiArtifactParameterDefinition } from '@kody-internal/shared/ui-artifact-parameters.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { parseRepoManifest } from './manifest.ts'
import { type AppManifest } from './types.ts'
import { repoSessionRpc } from './repo-session-do.ts'

export type ResolvedSavedAppSource = {
	title: string
	description: string
	hidden: boolean
	parameters: Array<UiArtifactParameterDefinition> | null
	clientCode: string
	serverCode: string | null
	serverCodeId: string
	sourceId: string | null
	publishedCommit: string | null
}

const savedAppSourceCache = new Map<string, ResolvedSavedAppSource>()
const savedAppSourceCacheLimit = 100

function buildSavedAppSourceCacheKey(input: {
	sourceId: string
	publishedCommit: string | null
}) {
	return `${input.sourceId}:${input.publishedCommit ?? 'unpublished'}`
}

function rememberSavedAppSource(
	cacheKey: string,
	value: ResolvedSavedAppSource,
) {
	if (savedAppSourceCache.has(cacheKey)) {
		savedAppSourceCache.delete(cacheKey)
	}
	savedAppSourceCache.set(cacheKey, value)
	if (savedAppSourceCache.size > savedAppSourceCacheLimit) {
		const oldestKey = savedAppSourceCache.keys().next().value
		if (oldestKey) {
			savedAppSourceCache.delete(oldestKey)
		}
	}
}

function fallbackFromArtifact(artifact: UiArtifactRow): ResolvedSavedAppSource {
	return {
		title: artifact.title,
		description: artifact.description,
		hidden: artifact.hidden,
		parameters: parseUiArtifactParameters(artifact.parameters),
		clientCode: artifact.clientCode ?? '',
		serverCode: artifact.serverCode ?? null,
		serverCodeId: artifact.serverCodeId,
		sourceId: artifact.sourceId,
		publishedCommit: null,
	}
}

function resolveManifestClientPath(manifest: AppManifest) {
	if (Array.isArray(manifest.assets) && manifest.assets.length > 0) {
		return manifest.assets[0]!
	}
	if (typeof manifest.client === 'string') {
		return manifest.client
	}
	if (Array.isArray(manifest.client) && manifest.client.length > 0) {
		return manifest.client[0]!
	}
	return 'client.html'
}

function canResolveRepoBackedSource(env: Env, artifact: UiArtifactRow) {
	return (
		artifact.sourceId != null &&
		typeof (env as Env & { APP_DB?: unknown }).APP_DB === 'object' &&
		typeof (env as Env & { REPO_SESSION?: unknown }).REPO_SESSION === 'object'
	)
}

export async function resolveSavedAppSource(input: {
	env: Env
	baseUrl: string
	artifact: UiArtifactRow
}): Promise<ResolvedSavedAppSource> {
	const fallback = fallbackFromArtifact(input.artifact)
	if (!canResolveRepoBackedSource(input.env, input.artifact)) {
		return fallback
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.artifact.sourceId!,
	)
	if (!source) return fallback
	const cacheKey = buildSavedAppSourceCacheKey({
		sourceId: source.id,
		publishedCommit: source.published_commit,
	})
	const cached = savedAppSourceCache.get(cacheKey)
	if (cached) return cached
	const sessionId = `app-source-${source.id}`
	const session = repoSessionRpc(input.env, sessionId)
	let openedSessionId: string | null = null
	try {
		const opened = await session.openSession({
			sessionId,
			sourceId: source.id,
			userId: input.artifact.user_id,
			baseUrl: input.baseUrl,
			sourceRoot: source.source_root,
		})
		openedSessionId = opened.id
		const manifestFile = await session.readFile({
			sessionId: opened.id,
			path: source.manifest_path,
		})
		if (!manifestFile.content) return fallback
		const manifest = parseRepoManifest({
			content: manifestFile.content,
			manifestPath: source.manifest_path,
		})
		if (manifest.kind !== 'app') return fallback
		const [clientFile, serverFile] = await Promise.all([
			session.readFile({
				sessionId: opened.id,
				path: resolveManifestClientPath(manifest),
			}),
			session.readFile({
				sessionId: opened.id,
				path: manifest.server,
			}),
		])
		const resolved = {
			title: manifest.title,
			description: manifest.description,
			hidden: manifest.hidden ?? fallback.hidden,
			parameters:
				(manifest.parameters as Array<UiArtifactParameterDefinition>) ?? null,
			clientCode: clientFile.content ?? fallback.clientCode,
			serverCode: serverFile.content ?? fallback.serverCode,
			serverCodeId: source.published_commit ?? fallback.serverCodeId,
			sourceId: source.id,
			publishedCommit: source.published_commit,
		}
		rememberSavedAppSource(cacheKey, resolved)
		return resolved
	} finally {
		if (openedSessionId) {
			await session.discardSession({ sessionId: openedSessionId }).catch(() => {
				// Best effort only; source resolution should preserve the original error.
			})
		}
	}
}
