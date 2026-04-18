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
	sourceId: string | null
	publishedCommit: string | null
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

function assertRepoSourceBindings(env: Env) {
	const anyEnv = env as Env & { APP_DB?: unknown; REPO_SESSION?: unknown }
	if (
		anyEnv.APP_DB == null ||
		typeof anyEnv.APP_DB !== 'object' ||
		typeof (anyEnv.APP_DB as D1Database).prepare !== 'function'
	) {
		throw new Error('APP_DB binding is required to load saved app source.')
	}
	if (anyEnv.REPO_SESSION == null || typeof anyEnv.REPO_SESSION !== 'object') {
		throw new Error('REPO_SESSION binding is required to load saved app source.')
	}
}

export async function resolveSavedAppSource(input: {
	env: Env
	baseUrl: string
	artifact: UiArtifactRow
}): Promise<ResolvedSavedAppSource> {
	assertRepoSourceBindings(input.env)
	if (!input.artifact.sourceId) {
		throw new Error(`Saved app "${input.artifact.id}" is missing its source id.`)
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.artifact.sourceId,
	)
	if (!source) {
		throw new Error(`Saved app source "${input.artifact.sourceId}" was not found.`)
	}
	if (!source.published_commit) {
		throw new Error(`Saved app source "${source.id}" has not been published yet.`)
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
				`Saved app server asset "${manifest.server}" was not found in repo source "${source.id}".`,
			)
		}
		return {
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
