import { repoSessionRpc } from './repo-session-do.ts'
import { getEntitySourceById } from './entity-sources.ts'

type SyncArtifactSourceInput = {
	env: Env
	userId: string
	baseUrl: string
	sourceId: string | null
	files: Record<string, string>
}

function canSyncArtifactSource(env: Env) {
	return (
		typeof (env as Env & { ARTIFACTS?: unknown }).ARTIFACTS === 'object' &&
		(env as Env & { ARTIFACTS?: unknown }).ARTIFACTS != null &&
		typeof (env as Env & { REPO_SESSION?: unknown }).REPO_SESSION ===
			'object' &&
		(env as Env & { REPO_SESSION?: unknown }).REPO_SESSION != null &&
		typeof (env as Env & { APP_DB?: unknown }).APP_DB === 'object' &&
		(env as Env & { APP_DB?: unknown }).APP_DB != null
	)
}

function buildSyncSessionId(sourceId: string) {
	return `source-sync-${sourceId}-${crypto.randomUUID()}`
}

export async function syncArtifactSourceSnapshot(
	input: SyncArtifactSourceInput,
): Promise<string | null> {
	if (!input.sourceId) return null
	if (!canSyncArtifactSource(input.env)) return null
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) return null
	const sessionId = buildSyncSessionId(source.id)
	const session = repoSessionRpc(input.env, sessionId)
	try {
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
			edits: Object.entries(input.files).map(([path, content]) => ({
				kind: 'write' as const,
				path,
				content,
			})),
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
