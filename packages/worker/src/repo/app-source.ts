import { type UiArtifactParameterDefinition } from '@kody-internal/shared/ui-artifact-parameters.ts'
import {
	normalizeUiArtifactParameters,
	parseUiArtifactParameters,
} from '#mcp/ui-artifact-parameters.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { isLoopbackHostname, readMockArtifactSnapshot } from './artifacts.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { normalizeRepoWorkspacePath, parseRepoManifest } from './manifest.ts'
import { type AppManifest } from './types.ts'
import { repoSessionRpc } from './repo-session-do.ts'

export type ResolvedSavedAppSource = {
	id: string
	title: string
	description: string
	hidden: boolean
	parameters: Array<UiArtifactParameterDefinition> | null
	clientCode: string
	serverCode: string | null
	serverCodeId: string
	sourceId: string
	publishedCommit: string | null
}

function resolveManifestClientPath(manifest: AppManifest) {
	if (Array.isArray(manifest.assets) && manifest.assets.length > 0) {
		return normalizeRepoWorkspacePath(manifest.assets[0]!)
	}
	if (typeof manifest.client === 'string') {
		return normalizeRepoWorkspacePath(manifest.client)
	}
	if (Array.isArray(manifest.client) && manifest.client.length > 0) {
		return normalizeRepoWorkspacePath(manifest.client[0]!)
	}
	return 'client.html'
}

function canResolveRepoBackedSource(env: Env, artifact: UiArtifactRow) {
	const anyEnv = env as Env & { APP_DB?: unknown; REPO_SESSION?: unknown }
	return (
		artifact.sourceId != null &&
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
	if (!canResolveRepoBackedSource(input.env, input.artifact)) {
		throw new Error('Saved app source bindings are not available.')
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.artifact.sourceId!,
	)
	if (!source) {
		throw new Error(
			`Saved app source "${input.artifact.sourceId}" was not found.`,
		)
	}
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
						`Saved app manifest "${source.manifest_path}" was not found in the repo source.`,
					)
				}
				const manifest = parseRepoManifest({
					content: manifestContent,
					manifestPath: source.manifest_path,
				})
				if (manifest.kind !== 'app') {
					throw new Error(`Repo source "${source.id}" is not an app manifest.`)
				}
				const clientPath = resolveManifestClientPath(manifest)
				const clientCode = snapshot.files[clientPath]
				if (!clientCode) {
					throw new Error(
						`Saved app client asset "${clientPath}" was not found in the repo source.`,
					)
				}
				const serverPath =
					input.artifact.hasServerCode && manifest.server
						? normalizeRepoWorkspacePath(manifest.server)
						: null
				const serverCode = serverPath
					? (snapshot.files[serverPath] ?? null)
					: null
				if (serverPath && !serverCode) {
					throw new Error(
						`Saved app server module "${manifest.server}" was not found in the repo source.`,
					)
				}
				return {
					id: input.artifact.id,
					title: manifest.title,
					description: manifest.description,
					hidden: manifest.hidden ?? input.artifact.hidden,
					parameters: manifest.parameters
						? normalizeUiArtifactParameters(manifest.parameters)
						: parseUiArtifactParameters(input.artifact.parameters),
					clientCode,
					serverCode,
					serverCodeId: source.published_commit ?? source.id,
					sourceId: source.id,
					publishedCommit: source.published_commit,
				}
			}
		}
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
				`Saved app manifest "${source.manifest_path}" was not found in the repo source.`,
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
			input.artifact.hasServerCode && manifest.server
				? session.readFile({
						sessionId: opened.id,
						userId: input.artifact.user_id,
						path: normalizeRepoWorkspacePath(manifest.server),
					})
				: Promise.resolve({ path: '', content: null }),
		])
		if (!clientFile.content) {
			throw new Error(
				`Saved app client asset "${resolveManifestClientPath(manifest)}" was not found in the repo source.`,
			)
		}
		if (
			input.artifact.hasServerCode &&
			manifest.server &&
			!serverFile.content
		) {
			throw new Error(
				`Saved app server module "${manifest.server}" was not found in the repo source.`,
			)
		}
		const resolved = {
			id: input.artifact.id,
			title: manifest.title,
			description: manifest.description,
			hidden: manifest.hidden ?? input.artifact.hidden,
			parameters: manifest.parameters
				? normalizeUiArtifactParameters(manifest.parameters)
				: parseUiArtifactParameters(input.artifact.parameters),
			clientCode: clientFile.content,
			serverCode: input.artifact.hasServerCode ? serverFile.content : null,
			serverCodeId: source.published_commit ?? source.id,
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
