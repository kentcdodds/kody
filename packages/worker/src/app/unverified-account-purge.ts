import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
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

function cutoffIso(now: Date, days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function unverifiedAccountSqlConditions() {
	return [
		'email_verified_at IS NULL',
		'deleting_at IS NULL',
		`account_type = 'person'`,
		'datetime(created_at) < datetime(?)',
		`NOT EXISTS (
			SELECT 1
			FROM oauth_connections
			WHERE oauth_connections.user_id = users.id
		)`,
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
	cutoff: string
	batchSize: number
}) {
	const conditions = unverifiedAccountSqlConditions().join('\n			AND ')
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id, stable_user_id, email, created_at
				FROM users
				WHERE ${conditions}
				ORDER BY datetime(created_at) ASC, id ASC
				LIMIT ?`,
			)
			.bind(input.cutoff, input.batchSize)
			.all<UnverifiedAccountRow>(),
	)
	return results ?? []
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
	const cutoff = cutoffIso(now, unverifiedAccountPurgeDays)
	const result: UnverifiedAccountPurgeResult = {
		scanned: 0,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
	}
	const page = await listUnverifiedAccountsPage({
		db: input.env.APP_DB,
		cutoff,
		batchSize,
	})
	result.scanned = page.length
	let processedAny = false
	for (const account of page) {
		if (processedAny && Date.now() - startedAtMs >= timeBudgetMs) {
			result.timeBudgetExhausted = true
			break
		}
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
		processedAny = true
	}
	console.info('unverified-account-purge', JSON.stringify(result))
	return result
}
