import { type UiArtifactParameterDefinition } from '@kody-internal/shared/ui-artifact-parameters.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { parseRepoManifest } from './manifest.ts'
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
	const sessionId = `app-source-${source.id}`
	const session = await repoSessionRpc(input.env, sessionId).openSession({
		sessionId,
		sourceId: source.id,
		userId: input.artifact.user_id,
		baseUrl: input.baseUrl,
		sourceRoot: source.source_root,
	})
	const manifestFile = await repoSessionRpc(input.env, session.id).readFile({
		sessionId: session.id,
		path: source.manifest_path,
	})
	if (!manifestFile.content) return fallback
	const manifest = parseRepoManifest({
		content: manifestFile.content,
		manifestPath: source.manifest_path,
	})
	if (manifest.kind !== 'app') return fallback
	const clientPath =
		manifest.assets?.[0] ??
		(typeof manifest.client === 'string' ? manifest.client : 'client.html')
	const [clientFile, serverFile] = await Promise.all([
		repoSessionRpc(input.env, session.id).readFile({
			sessionId: session.id,
			path: clientPath,
		}),
		repoSessionRpc(input.env, session.id).readFile({
			sessionId: session.id,
			path: manifest.server,
		}),
	])
	return {
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
}
