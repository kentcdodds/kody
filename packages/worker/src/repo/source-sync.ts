import { hasArtifactsAccess } from './artifacts.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { repoSessionRpc } from './repo-session-do.ts'

type SyncArtifactSourceInput = {
	env: Env
	userId: string
	baseUrl: string
	sourceId: string
	files: Record<string, string>
}

function canSyncArtifactSource(env: Env) {
	return (
		hasArtifactsAccess(env) &&
		(env as Env & { REPO_SESSION?: DurableObjectNamespace | undefined })
			.REPO_SESSION != null &&
		typeof (env as Env & { APP_DB?: D1Database | undefined }).APP_DB?.prepare ===
			'function'
	)
}

function buildSyncSessionId(sourceId: string) {
	return `source-sync-${sourceId}-${crypto.randomUUID()}`
}

export async function syncArtifactSourceSnapshot(
	input: SyncArtifactSourceInput,
): Promise<string> {
	if (!canSyncArtifactSource(input.env)) {
		throw new Error(
			'Repo-backed source sync requires APP_DB, REPO_SESSION, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN.',
		)
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) {
		throw new Error(`Source "${input.sourceId}" was not found.`)
	}
	const sessionId = buildSyncSessionId(source.id)
	const session = repoSessionRpc(input.env, sessionId)
	const edits = Object.entries(input.files).map(([path, content]) => ({
		kind: 'write' as const,
		path,
		content,
	}))
	try {
		if (!source.published_commit) {
			const bootstrapResult = await session.bootstrapSource({
				sessionId,
				sourceId: source.id,
				userId: input.userId,
				edits,
			})
			return bootstrapResult.publishedCommit
		}
		await session.openSession({
			sessionId,
			sourceId: source.id,
			userId: input.userId,
			baseUrl: input.baseUrl,
			sourceRoot: source.source_root,
		})
		await session.applyEdits({
			sessionId,
			userId: input.userId,
			edits,
			dryRun: false,
			rollbackOnError: true,
		})
		const publishResult = await session.publishSession({
			sessionId,
			userId: input.userId,
			force: true,
		})
		if (publishResult.status !== 'ok') {
			throw new Error(publishResult.message)
		}
		return publishResult.publishedCommit
	} finally {
		await session
			.discardSession({ sessionId, userId: input.userId })
			.catch(() => {
				// Best effort only; publish/apply failures should preserve the root cause.
			})
	}
}
