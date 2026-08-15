import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { listRepoSessionsForBranchCleanup } from './repo-sessions.ts'
import { repoSessionRpc } from './repo-session-do.ts'

const defaultCleanupBatchSize = 100
/**
 * Read-only leftovers (never checkpointed) are cheap to lose — there is no
 * unpublished work — so they sweep after a short idle window. Edited sessions
 * keep the generous window because unpublished work in a swept session is
 * unrecoverable. Every session operation bumps `updated_at`, so both windows
 * are idle time, not age.
 */
const unusedAbandonedSessionRetentionMs = 30 * 60 * 1000
const editedAbandonedSessionRetentionMs = 7 * 24 * 60 * 60 * 1000

export type RepoSessionBranchCleanupResult = {
	checked: number
	deleted: number
	errors: number
}

function abandonedBeforeIso(now: Date, retentionMs: number) {
	return new Date(now.valueOf() - retentionMs).toISOString()
}

export async function cleanupRepoSessionBranches(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<RepoSessionBranchCleanupResult> {
	const now = input.now ?? new Date()
	const sessions = await listRepoSessionsForBranchCleanup(input.env.APP_DB, {
		now: now.toISOString(),
		unusedAbandonedBefore: abandonedBeforeIso(
			now,
			unusedAbandonedSessionRetentionMs,
		),
		editedAbandonedBefore: abandonedBeforeIso(
			now,
			editedAbandonedSessionRetentionMs,
		),
		limit: input.batchSize ?? defaultCleanupBatchSize,
	})
	let deleted = 0
	let errors = 0
	for (const session of sessions) {
		const reason = session.status === 'active' ? 'abandoned' : 'expired'
		try {
			await repoSessionRpc(input.env, session.id).cleanupSessionBranch({
				sessionId: session.id,
				userId: session.user_id,
				reason,
			})
			deleted += 1
		} catch (error) {
			errors += 1
			console.warn(
				JSON.stringify({
					message: 'repo session branch cleanup failed',
					reason,
					error: getErrorMessage(error),
				}),
			)
		}
	}
	return {
		checked: sessions.length,
		deleted,
		errors,
	}
}
