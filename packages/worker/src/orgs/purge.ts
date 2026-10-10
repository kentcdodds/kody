/**
 * soft-delete-read-filter: opt-out
 *
 * Purge claims and hard-deletes soft-deleted rows past the retention window.
 */

import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import {
	hardPurgeOrg,
	hardPurgeSoftDeletedUser,
} from '#worker/orgs/hard-purge.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'

export { shouldRunRetentionCron as shouldRunSoftDeletePurgeCron }

export const softDeletePurgeBatchSize = 5
export const softDeletePurgeRunTimeBudgetMs = 20_000
export const softDeletePurgeRetryBackoffMs = 6 * 60 * 60 * 1000

export function softDeletePurgeWritesEnabled(env: Env): boolean {
	return (
		(
			env as Env & { SOFT_DELETE_PURGE_ENABLED?: string }
		).SOFT_DELETE_PURGE_ENABLED?.trim() === 'true'
	)
}

export type SoftDeletePurgeCandidate = {
	kind: 'org' | 'user'
	id: OwnerId
	deletedAt: string
	ageDays: number
	dbUserId?: number
}

export type SoftDeletePurgeOutcomeKind =
	| 'purged'
	| 'failed'
	| 'skipped_claim'
	| 'would_purge'

export type SoftDeletePurgeOutcome = {
	kind: 'org' | 'user'
	id: OwnerId
	ageDays: number
	outcome: SoftDeletePurgeOutcomeKind
	error?: string
}

export type SoftDeletePurgeResult = {
	dryRun: boolean
	scanned: number
	purged: number
	failed: number
	timeBudgetExhausted: boolean
	outcomes: Array<SoftDeletePurgeOutcome>
}

function ageDays(deletedAt: string, now: Date) {
	const deletedMs = Date.parse(deletedAt)
	if (!Number.isFinite(deletedMs)) return 0
	return Math.floor((now.getTime() - deletedMs) / (24 * 60 * 60 * 1000))
}

function cutoffIso(now: Date, millisecondsAgo: number) {
	return new Date(now.getTime() - millisecondsAgo).toISOString()
}

async function listOrgCandidates(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id, deleted_at
				 FROM orgs
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (deleting_at IS NULL OR datetime(deleting_at) < datetime(?))
				 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
				 LIMIT ?`,
			)
			.bind(input.ageCutoff, input.retryBackoffCutoff, input.batchSize)
			.all<{ id: OwnerId; deleted_at: string }>(),
	)
	return results ?? []
}

async function listUserCandidates(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	batchSize: number
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id AS db_user_id, stable_user_id AS id, deleted_at
				 FROM users
				 WHERE deleted_at IS NOT NULL
				   AND datetime(deleted_at) < datetime(?)
				   AND (deleting_at IS NULL OR datetime(deleting_at) < datetime(?))
				 ORDER BY (deleting_at IS NULL) DESC, datetime(deleted_at) ASC, id ASC
				 LIMIT ?`,
			)
			.bind(input.ageCutoff, input.retryBackoffCutoff, input.batchSize)
			.all<{ db_user_id: number; id: OwnerId; deleted_at: string }>(),
	)
	return results ?? []
}

export async function listSoftDeletePurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<{
	scanned: number
	candidates: Array<SoftDeletePurgeCandidate>
}> {
	const now = input.now ?? new Date()
	const ageCutoff = softDeletePurgeCutoffIso(now)
	const retryBackoffCutoff = cutoffIso(now, softDeletePurgeRetryBackoffMs)
	const batchSize = input.batchSize ?? softDeletePurgeBatchSize
	const orgs = await listOrgCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		batchSize,
	})
	const users = await listUserCandidates({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		batchSize,
	})
	const candidates: Array<SoftDeletePurgeCandidate> = [
		...orgs.map((row) => ({
			kind: 'org' as const,
			id: row.id,
			deletedAt: row.deleted_at,
			ageDays: ageDays(row.deleted_at, now),
		})),
		...users.map((row) => ({
			kind: 'user' as const,
			id: row.id,
			deletedAt: row.deleted_at,
			ageDays: ageDays(row.deleted_at, now),
			dbUserId: row.db_user_id,
		})),
	]
	return { scanned: candidates.length, candidates }
}

async function claimOrgForPurge(input: {
	db: D1Database
	orgId: string
	nowIso: string
	retryBackoffCutoff: string
}): Promise<boolean> {
	const created = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE orgs
				 SET deleting_at = ?, updated_at = ?
				 WHERE id = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL`,
			)
			.bind(input.nowIso, input.nowIso, input.orgId)
			.run(),
	)
	if ((created.meta.changes ?? 0) === 1) return true
	const restamped = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE orgs
				 SET deleting_at = ?, updated_at = ?
				 WHERE id = ?
				   AND deleted_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
			)
			.bind(input.nowIso, input.nowIso, input.orgId, input.retryBackoffCutoff)
			.run(),
	)
	return (restamped.meta.changes ?? 0) === 1
}

async function claimUserForPurge(input: {
	db: D1Database
	userId: string
	nowIso: string
	retryBackoffCutoff: string
}): Promise<boolean> {
	const created = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				 SET deleting_at = ?, updated_at = ?
				 WHERE stable_user_id = ?
				   AND deleted_at IS NOT NULL
				   AND deleting_at IS NULL`,
			)
			.bind(input.nowIso, input.nowIso, input.userId)
			.run(),
	)
	if ((created.meta.changes ?? 0) === 1) return true
	const restamped = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				 SET deleting_at = ?, updated_at = ?
				 WHERE stable_user_id = ?
				   AND deleted_at IS NOT NULL
				   AND datetime(deleting_at) < datetime(?)`,
			)
			.bind(input.nowIso, input.nowIso, input.userId, input.retryBackoffCutoff)
			.run(),
	)
	return (restamped.meta.changes ?? 0) === 1
}

export async function pruneSoftDeleted(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
	/** When true, list only. When false, hard-delete if writes are enabled. */
	dryRun?: boolean
	enableWrites?: boolean
}): Promise<SoftDeletePurgeResult> {
	const now = input.now ?? new Date()
	const dryRun =
		input.dryRun === true ||
		(input.dryRun !== false &&
			!(input.enableWrites === true || softDeletePurgeWritesEnabled(input.env)))
	const budgetMs = input.timeBudgetMs ?? softDeletePurgeRunTimeBudgetMs
	const started = Date.now()
	const preview = await listSoftDeletePurgeCandidates({
		env: input.env,
		now,
		batchSize: input.batchSize,
	})
	const outcomes: Array<SoftDeletePurgeOutcome> = []
	let purged = 0
	let failed = 0
	let timeBudgetExhausted = false

	if (dryRun) {
		for (const candidate of preview.candidates) {
			outcomes.push({
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				outcome: 'would_purge',
			})
		}
		return {
			dryRun: true,
			scanned: preview.scanned,
			purged: 0,
			failed: 0,
			timeBudgetExhausted: false,
			outcomes,
		}
	}

	const retryBackoffCutoff = cutoffIso(now, softDeletePurgeRetryBackoffMs)
	const nowIso = now.toISOString()

	for (const candidate of preview.candidates) {
		if (Date.now() - started > budgetMs) {
			timeBudgetExhausted = true
			break
		}
		try {
			const claimed =
				candidate.kind === 'org'
					? await claimOrgForPurge({
							db: input.env.APP_DB,
							orgId: candidate.id,
							nowIso,
							retryBackoffCutoff,
						})
					: await claimUserForPurge({
							db: input.env.APP_DB,
							userId: candidate.id,
							nowIso,
							retryBackoffCutoff,
						})
			if (!claimed) {
				outcomes.push({
					kind: candidate.kind,
					id: candidate.id,
					ageDays: candidate.ageDays,
					outcome: 'skipped_claim',
				})
				continue
			}
			if (candidate.kind === 'org') {
				await hardPurgeOrg({ env: input.env, orgId: candidate.id })
			} else {
				if (candidate.dbUserId == null) {
					throw new Error(`user_purge_missing_db_id:${candidate.id}`)
				}
				await hardPurgeSoftDeletedUser({
					env: input.env,
					dbUserId: candidate.dbUserId,
					stableUserId: candidate.id,
				})
			}
			purged += 1
			outcomes.push({
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				outcome: 'purged',
			})
		} catch (error) {
			failed += 1
			const message = error instanceof Error ? error.message : String(error)
			outcomes.push({
				kind: candidate.kind,
				id: candidate.id,
				ageDays: candidate.ageDays,
				outcome: 'failed',
				error: message,
			})
			await logOrgAuditEvent({
				env: input.env,
				orgId: candidate.id,
				action:
					candidate.kind === 'org' ? 'org.purge_failed' : 'user.purge_failed',
				result: 'failure',
				detailsJson: JSON.stringify({ error: message }),
				createdAt: nowIso,
			})
		}
	}

	return {
		dryRun: false,
		scanned: preview.scanned,
		purged,
		failed,
		timeBudgetExhausted,
		outcomes,
	}
}
