import { parseRepoManifest } from './manifest.ts'
import { repoSessionRpc } from './repo-session-do.ts'

type RepoBackedCodeKind = 'job' | 'skill'

type ResolveRepoBackedCodeInput = {
	env: Env
	userId: string
	baseUrl: string
	sourceId: string
	entityId: string
	expectedKind: RepoBackedCodeKind
	entityLabel: string
	sessionPrefix: string
}

function repoSessionNeedsRefresh(session: {
	base_commit: string | null
	published_commit: string | null
}) {
	return (
		session.published_commit != null &&
		session.base_commit !== session.published_commit
	)
}

export async function resolveRepoBackedCode(input: ResolveRepoBackedCodeInput) {
	const sessionId = `${input.sessionPrefix}-${input.entityId}-${crypto.randomUUID()}`
	const sessionClient = repoSessionRpc(input.env, sessionId)
	const openSessionInput = {
		sessionId,
		sourceId: input.sourceId,
		userId: input.userId,
		baseUrl: input.baseUrl,
		sourceRoot: '/',
	}
	let session = await sessionClient.openSession(openSessionInput)
	if (repoSessionNeedsRefresh(session)) {
		await sessionClient.discardSession({
			sessionId: session.id,
			userId: input.userId,
		})
		session = await sessionClient.openSession(openSessionInput)
		if (repoSessionNeedsRefresh(session)) {
			throw new Error(
				`Repo session "${session.id}" still points at base commit "${session.base_commit}" instead of published commit "${session.published_commit}".`,
			)
		}
	}
	try {
		const manifestPath =
			session.manifest_path?.replace(/^\/+/, '') || 'kody.json'
		const manifestFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.userId,
			path: manifestPath,
		})
		if (!manifestFile.content) {
			throw new Error(
				`${input.entityLabel} manifest "${manifestPath}" was not found in repo session.`,
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
		const entrypointFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.userId,
			path: manifest.entrypoint.replace(/^\/+/, ''),
		})
		if (!entrypointFile.content) {
			throw new Error(
				`${input.entityLabel} entrypoint "${manifest.entrypoint}" was not found in repo session.`,
			)
		}
		return entrypointFile.content
	} finally {
		await sessionClient
			.discardSession({
				sessionId: session.id,
				userId: input.userId,
			})
			.catch(() => {
				// Best effort; preserve the original error.
			})
	}
}
