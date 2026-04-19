import {
	getManifestEntrypointPath,
	parseRepoManifest,
} from '#worker/repo/manifest.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

type RepoModuleKind = 'job' | 'skill'

function formatKindLabel(kind: RepoModuleKind) {
	return `${kind[0]!.toUpperCase()}${kind.slice(1)}`
}

export async function readRepoModuleSource(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
	expectedKind: RepoModuleKind
	sessionIdPrefix: string
}) {
	const sessionId = `${input.sessionIdPrefix}-${input.sourceId}-${crypto.randomUUID()}`
	const session = repoSessionRpc(input.env, sessionId)
	let openedSessionId: string | null = null
	const kindLabel = formatKindLabel(input.expectedKind)
	try {
		const opened = await session.openSession({
			sessionId,
			sourceId: input.sourceId,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: null,
		})
		openedSessionId = opened.id
		const manifestPath =
			opened.manifest_path?.replace(/^\/+/, '') || 'kody.json'
		const manifestFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: manifestPath,
		})
		if (!manifestFile.content) {
			throw new Error(
				`${kindLabel} manifest "${manifestPath}" was not found in repo session.`,
			)
		}
		const manifest = parseRepoManifest({
			content: manifestFile.content,
			manifestPath,
		})
		if (manifest.kind !== input.expectedKind) {
			throw new Error(
				`Repo source "${input.sourceId}" is not a ${input.expectedKind} manifest.`,
			)
		}
		const moduleFile = await session.readFile({
			sessionId: opened.id,
			userId: input.userId,
			path: getManifestEntrypointPath(manifest),
		})
		if (!moduleFile.content) {
			throw new Error(
				`${kindLabel} entrypoint "${manifest.entrypoint}" was not found in repo session.`,
			)
		}
		return moduleFile.content
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
