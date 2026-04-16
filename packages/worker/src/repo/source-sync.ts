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
		(env as Env & { REPO_SESSION?: unknown }).REPO_SESSION != null
	)
}

function buildSyncSessionId(sourceId: string) {
	return `source-sync-${sourceId}`
}

export async function syncArtifactSourceSnapshot(
	input: SyncArtifactSourceInput,
): Promise<string | null> {
	if (!input.sourceId) return null
	if (!canSyncArtifactSource(input.env)) return null
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) return null
	const sessionId = buildSyncSessionId(source.id)
	await repoSessionRpc(input.env, sessionId).openSession({
		sessionId,
		sourceId: source.id,
		userId: input.userId,
		baseUrl: input.baseUrl,
		sourceRoot: source.source_root,
	})
	await repoSessionRpc(input.env, sessionId).applyEdits({
		sessionId,
		edits: Object.entries(input.files).map(([path, content]) => ({
			kind: 'write' as const,
			path,
			content,
		})),
		dryRun: false,
		rollbackOnError: true,
	})
	const publishResult = await repoSessionRpc(
		input.env,
		sessionId,
	).publishSession({
		sessionId,
		force: true,
	})
	if (publishResult.status !== 'ok') {
		throw new Error(publishResult.message)
	}
	await repoSessionRpc(input.env, sessionId).discardSession({ sessionId })
	return publishResult.publishedCommit
}
