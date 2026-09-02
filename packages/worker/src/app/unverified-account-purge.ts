import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
} from '#app/account-deletion.ts'

export { shouldRunRetentionCron as shouldRunUnverifiedAccountPurgeCron }

export const unverifiedAccountPurgeDays = 7
export const unverifiedAccountPurgeBatchSize = 5
/**
 * Total wall-clock budget for one unverified-account purge run. Matches the
 * retention lane: each hourly tick deletes bounded batches until the eligible
 * set is drained or this budget is exhausted.
 */
export const unverifiedAccountPurgeRunTimeBudgetMs = 20_000
/**
 * Skip rows whose `deleting_at` is newer than this window. Each claim restamps
 * `deleting_at`, so a failed deletion retries after this backoff instead of
 * every hourly tick or never.
 */
export const unverifiedAccountPurgeRetryBackoffMs = 6 * 60 * 60 * 1000

const millisecondsPerDay = 24 * 60 * 60 * 1000

type UnverifiedAccountRow = {
	id: number
	stable_user_id: string
	email: string
	created_at: string
}

export type UnverifiedAccountPurgeResult = {
	scanned: number
	purged: number
	failed: number
	timeBudgetExhausted: boolean
}

function cutoffIso(now: Date, millisecondsAgo: number) {
	return new Date(now.getTime() - millisecondsAgo).toISOString()
}

function unverifiedAccountSqlConditions() {
	return [
		'email_verified_at IS NULL',
		`account_type = 'person'`,
		'datetime(created_at) < datetime(?)',
		`NOT EXISTS (
			SELECT 1
			FROM oauth_connections
			WHERE oauth_connections.user_id = users.id
		)`,
		'(deleting_at IS NULL OR datetime(deleting_at) < datetime(?))',
	] as const
}

function deletionFailureWarnings(error: unknown) {
	if (error instanceof AccountDeletionCleanupError) {
		return error.cleanupErrors
	}
	if (error instanceof AccountDeletionInventoryError) {
		return error.inventoryErrors
	}
	return []
}

function ageDays(createdAt: string, now: Date) {
	const createdMs = Date.parse(
		createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`,
	)
	if (!Number.isFinite(createdMs)) return unverifiedAccountPurgeDays
	return Math.floor((now.getTime() - createdMs) / millisecondsPerDay)
}

async function listUnverifiedAccountsPage(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	batchSize: number
}) {
	const conditions = unverifiedAccountSqlConditions().join('\n			AND ')
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id, stable_user_id, email, created_at
				FROM users
				WHERE ${conditions}
				ORDER BY (deleting_at IS NULL) DESC, datetime(created_at) ASC, id ASC
				LIMIT ?`,
			)
			.bind(input.ageCutoff, input.retryBackoffCutoff, input.batchSize)
			.all<UnverifiedAccountRow>(),
	)
	return results ?? []
}

async function claimUnverifiedAccountForPurge(input: {
	db: D1Database
	dbUserId: number
	now: Date
	retryBackoffCutoff: string
}) {
	const deletingAt = utcSqliteTimestamp(input.now)
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				SET deleting_at = ?, updated_at = ?
				WHERE id = ?
					AND email_verified_at IS NULL
					AND account_type = 'person'
					AND NOT EXISTS (
						SELECT 1
						FROM oauth_connections
						WHERE oauth_connections.user_id = users.id
					)
					AND (deleting_at IS NULL OR datetime(deleting_at) < datetime(?))`,
			)
			.bind(deletingAt, deletingAt, input.dbUserId, input.retryBackoffCutoff)
			.run(),
	)
	return (result.meta.changes ?? 0) === 1
}

export async function pruneUnverifiedAccounts(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
}): Promise<UnverifiedAccountPurgeResult> {
	const now = input.now ?? new Date()
	const startedAtMs = Date.now()
	const timeBudgetMs =
		input.timeBudgetMs ?? unverifiedAccountPurgeRunTimeBudgetMs
	const batchSize = input.batchSize ?? unverifiedAccountPurgeBatchSize
	const ageCutoff = cutoffIso(
		now,
		unverifiedAccountPurgeDays * millisecondsPerDay,
	)
	const retryBackoffCutoff = cutoffIso(
		now,
		unverifiedAccountPurgeRetryBackoffMs,
	)
	const result: UnverifiedAccountPurgeResult = {
		scanned: 0,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
	}
	const page = await listUnverifiedAccountsPage({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		batchSize,
	})
	result.scanned = page.length
	for (const account of page) {
		if (Date.now() - startedAtMs >= timeBudgetMs) {
			result.timeBudgetExhausted = true
			break
		}
		const claimed = await claimUnverifiedAccountForPurge({
			db: input.env.APP_DB,
			dbUserId: account.id,
			now,
			retryBackoffCutoff,
		})
		if (!claimed) continue
		// deleteUserAccount is the self-service destructor: the authenticated
		// owner is typically verified, and the final D1 batch is
		// `DELETE FROM users WHERE id = ?`. Re-checking `email_verified_at IS
		// NULL` there would refuse self-service deletion. The purge invariant
		// is the claim UPDATE above; `markAccountDeleting` then sees
		// `deleting_at` already set (`created: false`) and retries without
		// rewriting the fence from an unguarded
		// `WHERE id = ? AND deleting_at IS NULL`.
		try {
			await deleteUserAccount({
				env: input.env,
				dbUserId: account.id,
				mcpUserId: account.stable_user_id,
			})
			await logAuditEvent({
				db: auditDatabaseFromEnv(input.env),
				category: 'account',
				action: 'unverified_account_purged',
				result: 'success',
				email: account.email,
				reason: `unverified_for_${ageDays(account.created_at, now)}_days`,
			})
			result.purged += 1
		} catch (error) {
			result.failed += 1
			console.warn('unverified_account_purge_failed', {
				userId: account.stable_user_id,
				warnings: deletionFailureWarnings(error),
				error,
			})
		}
	}
	console.info('unverified-account-purge', JSON.stringify(result))
	return result
}
