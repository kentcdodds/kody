import { type UiArtifactParameterDefinition } from '@kody-internal/shared/ui-artifact-parameters.ts'
import { normalizeUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
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
	sourceId: string
	publishedCommit: string
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

function canResolveRepoBackedSource(env: Env) {
	const anyEnv = env as Env & { APP_DB?: unknown; REPO_SESSION?: unknown }
	return (
		anyEnv.APP_DB != null &&
		typeof anyEnv.APP_DB === 'object' &&
		anyEnv.REPO_SESSION != null &&
		typeof anyEnv.REPO_SESSION === 'object'
	)
}

export async function resolveSavedAppSource(input: {
	env: Env
	baseUrl: string
	artifact: UiArtifactRow
}): Promise<ResolvedSavedAppSource> {
	if (!canResolveRepoBackedSource(input.env)) {
		throw new Error(
			'Saved app source resolution requires APP_DB and REPO_SESSION bindings.',
		)
	}
	if (!input.artifact.sourceId) {
		throw new Error('Saved app is missing a repo-backed source id.')
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.artifact.sourceId,
	)
	if (!source) {
		throw new Error(
			`Saved app source "${input.artifact.sourceId}" was not found for this user.`,
		)
	}
	if (!source.published_commit) {
		throw new Error(
			`Saved app source "${source.id}" does not have a published commit.`,
		)
	}
	const sessionId = `app-source-${source.id}-${crypto.randomUUID()}`
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
			userId: input.artifact.user_id,
			path: source.manifest_path,
		})
		if (!manifestFile.content) {
			throw new Error(
				`Saved app manifest "${source.manifest_path}" was not found in repo source "${source.id}".`,
			)
		}
		const manifest = parseRepoManifest({
			content: manifestFile.content,
			manifestPath: source.manifest_path,
		})
		if (manifest.kind !== 'app') {
			throw new Error(`Repo source "${source.id}" is not an app manifest.`)
		}
		const [clientFile, serverFile] = await Promise.all([
			session.readFile({
				sessionId: opened.id,
				userId: input.artifact.user_id,
				path: resolveManifestClientPath(manifest),
			}),
			session.readFile({
				sessionId: opened.id,
				userId: input.artifact.user_id,
				path: manifest.server,
			}),
		])
		if (!clientFile.content) {
			throw new Error(
				`Saved app client asset "${resolveManifestClientPath(manifest)}" was not found in repo source "${source.id}".`,
			)
		}
		if (!serverFile.content) {
			throw new Error(
				`Saved app server entry "${manifest.server}" was not found in repo source "${source.id}".`,
			)
		}
		const resolved: ResolvedSavedAppSource = {
			title: manifest.title,
			description: manifest.description,
			hidden: manifest.hidden ?? false,
			parameters: manifest.parameters
				? normalizeUiArtifactParameters(manifest.parameters)
				: null,
			clientCode: clientFile.content,
			serverCode: serverFile.content,
			serverCodeId: source.published_commit,
			sourceId: source.id,
			publishedCommit: source.published_commit,
		}
		return resolved
	} finally {
		if (openedSessionId) {
			await session
				.discardSession({
					sessionId: openedSessionId,
					userId: input.artifact.user_id,
				})
				.catch(() => {
					// Best effort only; source resolution should preserve the original error.
				})
		}
	}
}

export function hasSavedAppBackend(input: { serverCode: string | null }) {
	return input.serverCode != null
}
