import { repoSessionStorageBucketId } from '#worker/storage-buckets/service.ts'
import {
	getLeftoverD1RepoSession,
	listLeftoverD1RepoSessionsBySource,
	listLeftoverD1RepoSessionsByUser,
} from './repo-session-leftover-d1.ts'
import {
	repoSessionIndexRpc,
	type RepoSessionIndexEnv,
} from './repo-session-index-client.ts'
import { type RepoSessionRow } from './types.ts'

export type RepoSessionCatalogEnv = RepoSessionIndexEnv

function uniqueById(
	rows: ReadonlyArray<RepoSessionRow>,
): Array<RepoSessionRow> {
	const byId = new Map<string, RepoSessionRow>()
	for (const row of rows) {
		if (!byId.has(row.id)) byId.set(row.id, row)
	}
	return [...byId.values()]
}

export async function insertRepoSession(
	env: RepoSessionCatalogEnv,
	row: RepoSessionRow,
): Promise<void> {
	await repoSessionIndexRpc({ env, userId: row.user_id }).insertSession({
		ownerId: row.user_id,
		row,
	})
}

export async function getRepoSessionById(
	env: RepoSessionCatalogEnv,
	input: {
		userId: string
		sessionId: string
	},
): Promise<RepoSessionRow | null> {
	const index = repoSessionIndexRpc({ env, userId: input.userId })
	const fromIndex = await index.getSessionById({
		ownerId: input.userId,
		sessionId: input.sessionId,
	})
	if (fromIndex) return fromIndex
	const leftover = await getLeftoverD1RepoSession({
		db: env.APP_DB,
		userId: input.userId,
		sessionId: input.sessionId,
	})
	if (!leftover) return null
	await index.insertSession({ ownerId: input.userId, row: leftover })
	return leftover
}

export async function getActiveRepoSessionByConversation(
	env: RepoSessionCatalogEnv,
	input: {
		userId: string
		conversationId: string
	},
): Promise<RepoSessionRow | null> {
	return await repoSessionIndexRpc({
		env,
		userId: input.userId,
	}).getActiveByConversation({
		ownerId: input.userId,
		conversationId: input.conversationId,
	})
}

export async function listRepoSessionsBySource(
	env: RepoSessionCatalogEnv,
	input: {
		userId: string
		sourceId: string
	},
): Promise<Array<RepoSessionRow>> {
	const fromIndex = await repoSessionIndexRpc({
		env,
		userId: input.userId,
	}).listBySource({
		ownerId: input.userId,
		sourceId: input.sourceId,
	})
	const leftover = await listLeftoverD1RepoSessionsBySource({
		db: env.APP_DB,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	return uniqueById([...fromIndex, ...leftover])
}

export async function deleteRepoSessionsBySourceForUser(
	env: RepoSessionCatalogEnv,
	input: {
		userId: string
		sourceId: string
	},
): Promise<number> {
	const sessions = await listRepoSessionsBySource(env, input)
	if (sessions.length > 0) {
		const placeholders = sessions.map(() => '?').join(', ')
		await env.APP_DB.prepare(
			`DELETE FROM user_storage_buckets
			WHERE user_id = ?
				AND kind = 'repo_session'
				AND storage_id IN (${placeholders})`,
		)
			.bind(
				input.userId,
				...sessions.map((session) => repoSessionStorageBucketId(session.id)),
			)
			.run()
	}
	return await repoSessionIndexRpc({
		env,
		userId: input.userId,
	}).deleteBySource({
		ownerId: input.userId,
		sourceId: input.sourceId,
	})
}

export async function listRepoSessionsByUser(
	env: RepoSessionCatalogEnv,
	userId: string,
): Promise<Array<RepoSessionRow>> {
	const fromIndex = await repoSessionIndexRpc({
		env,
		userId,
	}).listByUser({ ownerId: userId })
	const leftover = await listLeftoverD1RepoSessionsByUser({
		db: env.APP_DB,
		userId,
	})
	return uniqueById([...fromIndex, ...leftover])
}

export async function updateRepoSession(
	env: RepoSessionCatalogEnv,
	input: {
		id: string
		userId: string
		sessionBranch?: string | null
		sourceBranch?: string
		baseCommit?: string
		sourceRoot?: string
		conversationId?: string | null
		status?: RepoSessionRow['status']
		expiresAt?: string | null
		lastCheckpointAt?: string | null
		lastCheckpointCommit?: string | null
		lastCheckRunId?: string | null
		lastCheckTreeHash?: string | null
	},
): Promise<boolean> {
	return await repoSessionIndexRpc({
		env,
		userId: input.userId,
	}).updateSession({
		ownerId: input.userId,
		sessionId: input.id,
		sessionBranch: input.sessionBranch,
		sourceBranch: input.sourceBranch,
		baseCommit: input.baseCommit,
		sourceRoot: input.sourceRoot,
		conversationId: input.conversationId,
		status: input.status,
		expiresAt: input.expiresAt,
		lastCheckpointAt: input.lastCheckpointAt,
		lastCheckpointCommit: input.lastCheckpointCommit,
		lastCheckRunId: input.lastCheckRunId,
		lastCheckTreeHash: input.lastCheckTreeHash,
	})
}

export async function deleteRepoSession(
	env: RepoSessionCatalogEnv,
	input: {
		userId: string
		sessionId: string
	},
): Promise<boolean> {
	return await repoSessionIndexRpc({
		env,
		userId: input.userId,
	}).deleteSession({
		ownerId: input.userId,
		sessionId: input.sessionId,
	})
}

export async function countActiveRepoSessions(
	env: RepoSessionCatalogEnv,
	userId: string,
): Promise<number> {
	return await repoSessionIndexRpc({ env, userId }).countActive({
		ownerId: userId,
	})
}

export async function hasActiveRepoSessionForSource(
	env: RepoSessionCatalogEnv,
	input: {
		userId: string
		sourceId: string
	},
): Promise<boolean> {
	return await repoSessionIndexRpc({
		env,
		userId: input.userId,
	}).hasActiveForSource({
		ownerId: input.userId,
		sourceId: input.sourceId,
	})
}
