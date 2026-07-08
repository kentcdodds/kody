import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'

type RetentionPolicy = {
	table: string
	scope: 'per-user' | 'global'
	retentionDays?: number
	maxRowsPerPartition?: number
	batchSize: number
	description: string
}

type RetentionPolicyExemption = {
	table: string
	reason: string
}

type IdValue = string | number

export const retentionCronGateMinutes = 5
export const retentionCronIntervalMinutes = 60
export const retentionDefaultBatchSize = 250
export const retentionDeleteIdsMaxParameters = 100
export const publishedBundleArtifactRetentionBatchSize = 100
/**
 * Total wall-clock budget for one retention cron run. Each hourly run keeps
 * deleting batches (round-robin across tables) until every table is drained
 * or this budget is exhausted, so backlogs shrink instead of only losing one
 * batch per table per hour.
 */
export const retentionRunTimeBudgetMs = 20_000
/**
 * Upper bound on distinct (user_id, package_id) pairs examined per runtime-run
 * cap batch, largest pairs first, so the cap prune never ranks the whole
 * table in one query.
 */
export const packageRuntimeCapPairsPerBatch = 20

export const packageRuntimeRunRetentionDays = 30
export const packageRuntimeMaxRunsPerPackage = 500
export const packageInvocationRetentionDays = 90
export const memorySuppressionRetentionDays = 90
export const workflowRunRetentionDays = 90
export const publishedBundleArtifactRetentionDays = 30
export const emailDeliveryEventRetentionDays = 90
export const emailMessageRetentionDays = 365
export const entitlementDailyCounterRetentionDays = 400
export const usageRollupRetentionMonths = 24
export const auditEventRetentionDays = 180

const millisecondsPerDay = 24 * 60 * 60 * 1000
const terminalWorkflowStatusList = terminalWorkflowStatusValues
	.map((status) => `'${status}'`)
	.join(', ')

/**
 * Inventory of D1 growth-table retention policies. Keep this manifest in sync
 * with the scheduled prune implementation and data-storage.md so future growth
 * tables have an explicit retention story or a documented exemption.
 */
export const retentionPolicies: ReadonlyArray<RetentionPolicy> = [
	{
		table: 'package_runtime_runs',
		scope: 'per-user',
		retentionDays: packageRuntimeRunRetentionDays,
		maxRowsPerPartition: packageRuntimeMaxRunsPerPackage,
		batchSize: retentionDefaultBatchSize,
		description:
			'Runtime debug runs keep 30 days and at most 500 rows per user/package. Running or actively referenced runs are kept.',
	},
	{
		table: 'package_runtime_logs',
		scope: 'per-user',
		batchSize: retentionDefaultBatchSize,
		description:
			'Runtime logs follow retained runtime runs; orphan logs are pruned in small batches.',
	},
	{
		table: 'package_invocations',
		scope: 'per-user',
		retentionDays: packageInvocationRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Package invocation idempotency rows keep terminal responses for 90 days; in-progress rows are never pruned.',
	},
	{
		table: 'mcp_memory_conversation_suppressions',
		scope: 'per-user',
		retentionDays: memorySuppressionRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Conversation suppression rows are kept while active and for up to 90 days since last seen.',
	},
	{
		table: 'workflow_runs',
		scope: 'per-user',
		retentionDays: workflowRunRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Workflow run projections keep terminal states for 90 days; non-terminal rows are never pruned.',
	},
	{
		table: 'published_bundle_artifacts',
		scope: 'per-user',
		retentionDays: publishedBundleArtifactRetentionDays,
		batchSize: publishedBundleArtifactRetentionBatchSize,
		description:
			'Published bundle rows, KV blobs, and the matching source snapshot KV keys are deleted only when older than 30 days, not current for any source, and not tied to an active repo session.',
	},
	{
		table: 'email_delivery_events',
		scope: 'per-user',
		retentionDays: emailDeliveryEventRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'User email delivery events keep 90 days; operator system email remains governed by system-email retention.',
	},
	{
		table: 'email_messages',
		scope: 'per-user',
		retentionDays: emailMessageRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'User email messages keep 365 days, oldest first. R2 raw MIME blobs are deleted before their rows; rows with blobs are skipped when the EMAIL_BLOBS binding is missing so blobs are never orphaned. Operator system:email messages remain governed by system-email retention.',
	},
	{
		table: 'email_attachments',
		scope: 'per-user',
		batchSize: retentionDefaultBatchSize,
		description:
			'Attachment rows follow their parent email messages and are deleted before the messages.',
	},
	{
		table: 'email_threads',
		scope: 'per-user',
		batchSize: retentionDefaultBatchSize,
		description:
			'Threads orphaned by email message retention are pruned for the affected users in the same run.',
	},
	{
		table: 'entitlement_daily_counters',
		scope: 'per-user',
		retentionDays: entitlementDailyCounterRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Daily entitlement rate counters keep 400 days so year-over-year usage stays inspectable before rows age out.',
	},
	{
		table: 'usage_rollups',
		scope: 'per-user',
		batchSize: retentionDefaultBatchSize,
		description:
			'Per user/metric/month usage rollups keep 24 months; Analytics Engine retains the raw event stream separately.',
	},
	{
		table: 'audit_events',
		scope: 'global',
		retentionDays: auditEventRetentionDays,
		batchSize: retentionDefaultBatchSize,
		description:
			'Global hashed auth/security audit events keep 180 days and are independent of account deletion.',
	},
] as const

export const retentionPolicyExemptions: ReadonlyArray<RetentionPolicyExemption> =
	[
		{
			table: 'archived_job_artifacts',
			reason:
				'Archived job artifact rows are bounded by retain_until and cleaned by the job artifact cleanup path.',
		},
		{
			table: 'mcp_memories',
			reason:
				'Memories are durable user-curated content removed by explicit user action or account deletion, not by time-based retention.',
		},
	] as const

export type RetentionPruneResult = {
	runtimeRuns: {
		deletedRuns: number
		deletedLogs: number
		deletedOrphanLogs: number
	}
	packageInvocations: number
	memorySuppressions: number
	workflowRuns: number
	publishedBundleArtifacts: {
		deletedRows: number
		deletedKvKeys: number
		deletedSnapshotKvKeys: number
		kvDeleteErrors: number
	}
	emailDeliveryEvents: number
	emailMessages: {
		deletedMessages: number
		deletedAttachments: number
		deletedThreads: number
		deletedRawMimeBlobs: number
		skippedMissingBlobBinding: number
		blobDeleteErrors: number
	}
	entitlementDailyCounters: number
	usageRollups: number
	auditEvents: number
	batchesPerTable: Record<string, number>
	timeBudgetExhausted: boolean
}

export function shouldRunRetentionCron(now: Date) {
	return (
		now.getUTCMinutes() < retentionCronGateMinutes &&
		now.getUTCMinutes() % retentionCronIntervalMinutes === 0
	)
}

export function getRetentionPolicyCoverage() {
	const covered = new Set<string>()
	for (const policy of retentionPolicies) {
		covered.add(policy.table)
	}
	for (const exemption of retentionPolicyExemptions) {
		covered.add(exemption.table)
	}
	return covered
}

function cutoffIso(now: Date, days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function cutoffMonth(now: Date, months: number) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
		.toISOString()
		.slice(0, 'YYYY-MM'.length)
}

function placeholders(values: ReadonlyArray<unknown>) {
	return values.map(() => '?').join(', ')
}

async function selectIds(input: {
	db: D1Database
	sql: string
	bindings: ReadonlyArray<string | number>
	column?: string
}): Promise<Array<IdValue>> {
	const column = input.column ?? 'id'
	const { results } = await input.db
		.prepare(input.sql)
		.bind(...input.bindings)
		.all<Record<string, unknown>>()
	return (results ?? []).map((row) => row[column] as IdValue)
}

/**
 * Runs a batched select-then-delete and reports both counts. `selected` (not
 * `deleted`) is what callers should feed into hasMore decisions: a full batch
 * that deletes fewer rows (racing writers) must not mark a table drained.
 */
async function selectAndDeleteByIds(input: {
	db: D1Database
	sql: string
	bindings: ReadonlyArray<string | number>
	column?: string
	table: string
	idColumn: string
}): Promise<{ selected: number; deleted: number }> {
	const ids = await selectIds(input)
	const deleted = await deleteByIds({
		db: input.db,
		table: input.table,
		idColumn: input.idColumn,
		ids,
	})
	return { selected: ids.length, deleted }
}

async function deleteByIds(input: {
	db: D1Database
	table: string
	idColumn: string
	ids: ReadonlyArray<IdValue>
}) {
	if (input.ids.length === 0) return 0
	let deleted = 0
	for (
		let index = 0;
		index < input.ids.length;
		index += retentionDeleteIdsMaxParameters
	) {
		const ids = input.ids.slice(index, index + retentionDeleteIdsMaxParameters)
		const result = await input.db
			.prepare(
				`DELETE FROM ${input.table}
				WHERE ${input.idColumn} IN (${placeholders(ids)})`,
			)
			.bind(...ids)
			.run()
		deleted += result.meta.changes ?? 0
	}
	return deleted
}

async function deletePublishedBundleArtifactRowIfStillStale(input: {
	db: D1Database
	id: string
	kvKey: string
	cutoff: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM published_bundle_artifacts
			WHERE id = ?
				AND kv_key = ?
				AND created_at < ?
				AND NOT EXISTS (
					SELECT 1
					FROM entity_sources AS source
					WHERE source.user_id = published_bundle_artifacts.user_id
						AND source.id = published_bundle_artifacts.source_id
						AND source.published_commit = published_bundle_artifacts.published_commit
				)
				AND NOT EXISTS (
					SELECT 1
					FROM repo_sessions AS session
					WHERE session.user_id = published_bundle_artifacts.user_id
						AND session.source_id = published_bundle_artifacts.source_id
						AND session.status = 'active'
				)`,
		)
		.bind(input.id, input.kvKey, input.cutoff)
		.run()
	return result.meta.changes ?? 0
}

/**
 * Keep-conditions shared by the age prune and the per-package cap prune.
 * Expects the outer query to alias package_runtime_runs as `run`.
 */
const runtimeRunKeepConditions = `run.status != 'running'
	AND NOT EXISTS (
		SELECT 1
		FROM package_invocations AS invocation
		WHERE invocation.user_id = run.user_id
			AND invocation.id = run.invocation_id
			AND invocation.status = 'in_progress'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM workflow_runs AS workflow
		WHERE workflow.user_id = run.user_id
			AND workflow.id = run.workflow_id
			AND (
				workflow.status IS NULL
				OR workflow.status NOT IN (${terminalWorkflowStatusList})
			)
	)
	AND NOT EXISTS (
		SELECT 1
		FROM repo_sessions AS session
		WHERE session.user_id = run.user_id
			AND session.id = run.session_id
			AND session.status = 'active'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM package_runtime_runs AS child_run
		WHERE child_run.user_id = run.user_id
			AND child_run.parent_run_id = run.id
			AND child_run.status = 'running'
	)`

export async function prunePackageRuntimeRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
	maxCapPairs?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = cutoffIso(now, packageRuntimeRunRetentionDays)
	const batchSize = input.batchSize ?? retentionDefaultBatchSize
	const maxCapPairs = input.maxCapPairs ?? packageRuntimeCapPairsPerBatch
	const ageRunIds = await selectIds({
		db: input.db,
		bindings: [cutoff, batchSize],
		sql: `SELECT id
			FROM package_runtime_runs AS run
			WHERE run.started_at < ?
				AND ${runtimeRunKeepConditions}
			ORDER BY run.started_at ASC, run.id ASC
			LIMIT ?`,
	})
	const runIds = new Set<IdValue>(ageRunIds)
	// The per-(user, package) cap prune examines a bounded set of the largest
	// pairs per batch instead of ranking the whole table with a window
	// function; remaining pairs are picked up by later batches or runs.
	let capPairCount = 0
	let capDeletedCandidates = 0
	if (runIds.size < batchSize) {
		const { results: pairs } = await input.db
			.prepare(
				`SELECT user_id, package_id, COUNT(*) AS run_count
				FROM package_runtime_runs
				GROUP BY user_id, package_id
				HAVING COUNT(*) > ?
				ORDER BY run_count DESC
				LIMIT ?`,
			)
			.bind(packageRuntimeMaxRunsPerPackage, maxCapPairs)
			.all<{ user_id: string; package_id: string; run_count: number }>()
		capPairCount = (pairs ?? []).length
		for (const pair of pairs ?? []) {
			if (runIds.size >= batchSize) break
			const capIds = await selectIds({
				db: input.db,
				bindings: [
					pair.user_id,
					pair.package_id,
					pair.user_id,
					pair.package_id,
					packageRuntimeMaxRunsPerPackage,
					batchSize - runIds.size,
				],
				sql: `SELECT id
					FROM package_runtime_runs AS run
					WHERE run.user_id = ?
						AND run.package_id = ?
						AND run.id NOT IN (
							SELECT recent.id
							FROM package_runtime_runs AS recent
							WHERE recent.user_id = ?
								AND recent.package_id = ?
							ORDER BY recent.started_at DESC, recent.id DESC
							LIMIT ?
						)
						AND ${runtimeRunKeepConditions}
					ORDER BY run.started_at ASC, run.id ASC
					LIMIT ?`,
			})
			for (const id of capIds) {
				capDeletedCandidates += 1
				runIds.add(id)
			}
		}
	}
	const ids = [...runIds]
	const deletedLogs = await deleteByIds({
		db: input.db,
		table: 'package_runtime_logs',
		idColumn: 'run_id',
		ids,
	})
	const deletedRuns = await deleteByIds({
		db: input.db,
		table: 'package_runtime_runs',
		idColumn: 'id',
		ids,
	})
	const orphanLogIds = await selectIds({
		db: input.db,
		bindings: [batchSize],
		sql: `SELECT log.id
			FROM package_runtime_logs AS log
			WHERE NOT EXISTS (
				SELECT 1
				FROM package_runtime_runs AS run
				WHERE run.user_id = log.user_id AND run.id = log.run_id
			)
			ORDER BY log.created_at ASC, log.id ASC
			LIMIT ?`,
	})
	const deletedOrphanLogs = await deleteByIds({
		db: input.db,
		table: 'package_runtime_logs',
		idColumn: 'id',
		ids: orphanLogIds,
	})
	const hasMore =
		ageRunIds.length >= batchSize ||
		ids.length >= batchSize ||
		orphanLogIds.length >= batchSize ||
		(capDeletedCandidates > 0 && capPairCount >= maxCapPairs)
	return { deletedRuns, deletedLogs, deletedOrphanLogs, hasMore }
}

export async function prunePackageInvocationsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		packageInvocationRetentionDays,
	)
	return selectAndDeleteByIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM package_invocations
			WHERE created_at < ?
				AND status != 'in_progress'
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		table: 'package_invocations',
		idColumn: 'id',
	})
}

export async function pruneMemorySuppressionsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = cutoffIso(now, memorySuppressionRetentionDays)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [
			now.toISOString(),
			cutoff,
			input.batchSize ?? retentionDefaultBatchSize,
		],
		sql: `SELECT rowid
			FROM mcp_memory_conversation_suppressions
			WHERE expires_at <= ?
				AND last_seen_at < ?
			ORDER BY last_seen_at ASC, rowid ASC
			LIMIT ?`,
		table: 'mcp_memory_conversation_suppressions',
		idColumn: 'rowid',
	})
}

export async function pruneWorkflowRunsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(input.now ?? new Date(), workflowRunRetentionDays)
	return selectAndDeleteByIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM workflow_runs
			WHERE status IN (${terminalWorkflowStatusList})
				AND COALESCE(completed_at, updated_at, created_at) < ?
			ORDER BY COALESCE(completed_at, updated_at, created_at) ASC, id ASC
			LIMIT ?`,
		table: 'workflow_runs',
		idColumn: 'id',
	})
}

export async function prunePublishedBundleArtifactsForRetention(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		publishedBundleArtifactRetentionDays,
	)
	const batchSize = input.batchSize ?? publishedBundleArtifactRetentionBatchSize
	const { results } = await input.env.APP_DB.prepare(
		`SELECT artifact.id, artifact.kv_key, artifact.source_id, artifact.published_commit
		FROM published_bundle_artifacts AS artifact
		WHERE artifact.created_at < ?
			AND NOT EXISTS (
				SELECT 1
				FROM entity_sources AS source
				WHERE source.user_id = artifact.user_id
					AND source.id = artifact.source_id
					AND source.published_commit = artifact.published_commit
			)
			AND NOT EXISTS (
				SELECT 1
				FROM repo_sessions AS session
				WHERE session.user_id = artifact.user_id
					AND session.source_id = artifact.source_id
					AND session.status = 'active'
			)
		ORDER BY artifact.created_at ASC, artifact.id ASC
		LIMIT ?`,
	)
		.bind(cutoff, batchSize)
		.all<{
			id: string
			kv_key: string
			source_id: string
			published_commit: string
		}>()
	const rows = results ?? []
	let deletedRows = 0
	let deletedKvKeys = 0
	let deletedSnapshotKvKeys = 0
	let kvDeleteErrors = 0
	const prunedSnapshotPairs = new Map<
		string,
		{ sourceId: string; publishedCommit: string }
	>()
	for (const row of rows) {
		const rowDeleted = await deletePublishedBundleArtifactRowIfStillStale({
			db: input.env.APP_DB,
			id: row.id,
			kvKey: row.kv_key,
			cutoff,
		})
		if (rowDeleted === 0) continue
		deletedRows += rowDeleted
		prunedSnapshotPairs.set(`${row.source_id}:${row.published_commit}`, {
			sourceId: row.source_id,
			publishedCommit: row.published_commit,
		})
		try {
			await input.env.BUNDLE_ARTIFACTS_KV.delete(row.kv_key)
			deletedKvKeys += 1
		} catch (error) {
			kvDeleteErrors += 1
			console.warn('retention-published-bundle-kv-delete-failed', {
				id: row.id,
				kvKey: row.kv_key,
				error,
			})
		}
	}
	// A pruned row already satisfied the safety conditions (commit not current
	// for any entity_sources row, no active repo session), so the source
	// snapshot KV keys for that commit are stale too.
	for (const pair of prunedSnapshotPairs.values()) {
		for (const kvKey of [
			buildPublishedSourceSnapshotKvKey(pair),
			buildPublishedSourceManifestSnapshotKvKey(pair),
		]) {
			try {
				await input.env.BUNDLE_ARTIFACTS_KV.delete(kvKey)
				deletedSnapshotKvKeys += 1
			} catch (error) {
				kvDeleteErrors += 1
				console.warn('retention-source-snapshot-kv-delete-failed', {
					sourceId: pair.sourceId,
					publishedCommit: pair.publishedCommit,
					kvKey,
					error,
				})
			}
		}
	}
	return {
		deletedRows,
		deletedKvKeys,
		deletedSnapshotKvKeys,
		kvDeleteErrors,
		hasMore: rows.length >= batchSize,
	}
}

export async function pruneEmailDeliveryEventsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(
		input.now ?? new Date(),
		emailDeliveryEventRetentionDays,
	)
	return selectAndDeleteByIds({
		db: input.db,
		bindings: [
			systemEmailOwnerId,
			cutoff,
			input.batchSize ?? retentionDefaultBatchSize,
		],
		sql: `SELECT id
			FROM email_delivery_events
			WHERE user_id != ?
				AND created_at < ?
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		table: 'email_delivery_events',
		idColumn: 'id',
	})
}

/**
 * Keyset cursor over (created_at, id) marking the last email message row
 * examined (selected, not necessarily deleted). Threading it through batches
 * within one run advances past rows skipped for blob reasons, so a blocked
 * head cannot wedge the prune. Cross-run persistence is unnecessary: the next
 * hourly run starts from the head and retries the skipped rows.
 */
export type EmailMessageRetentionCursor = {
	createdAt: string
	id: string
}

export type EmailMessageRetentionResult = {
	deletedMessages: number
	deletedAttachments: number
	deletedThreads: number
	deletedRawMimeBlobs: number
	skippedMissingBlobBinding: number
	blobDeleteErrors: number
	hasMore: boolean
	nextCursor: EmailMessageRetentionCursor | null
}

export async function pruneUserEmailMessagesForRetention(input: {
	db: D1Database
	blobs?: Pick<R2Bucket, 'delete'> | undefined
	now?: Date
	batchSize?: number
	cursor?: EmailMessageRetentionCursor | null
}): Promise<EmailMessageRetentionResult> {
	const cutoff = cutoffIso(input.now ?? new Date(), emailMessageRetentionDays)
	const batchSize = input.batchSize ?? retentionDefaultBatchSize
	const cursor = input.cursor ?? null
	const cursorClause = cursor
		? `AND (created_at > ? OR (created_at = ? AND id > ?))`
		: ''
	const cursorBindings = cursor
		? [cursor.createdAt, cursor.createdAt, cursor.id]
		: []
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, raw_mime_key, created_at
			FROM email_messages
			WHERE user_id != ?
				AND created_at < ?
				${cursorClause}
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		)
		.bind(systemEmailOwnerId, cutoff, ...cursorBindings, batchSize)
		.all<{
			id: string
			user_id: string
			raw_mime_key: string | null
			created_at: string
		}>()
	const rows = results ?? []
	const result: EmailMessageRetentionResult = {
		deletedMessages: 0,
		deletedAttachments: 0,
		deletedThreads: 0,
		deletedRawMimeBlobs: 0,
		skippedMissingBlobBinding: 0,
		blobDeleteErrors: 0,
		hasMore: false,
		nextCursor: null,
	}
	const rowsWithBlob = rows.filter((row) => row.raw_mime_key !== null)
	let deletableRows = rows
	if (rowsWithBlob.length > 0) {
		if (!input.blobs) {
			// Never delete a row whose R2 blob cannot be deleted first; skipping
			// keeps blobs from being orphaned when the binding is missing.
			result.skippedMissingBlobBinding = rowsWithBlob.length
			deletableRows = rows.filter((row) => row.raw_mime_key === null)
			console.warn('retention-email-raw-mime-binding-missing', {
				skipped: rowsWithBlob.length,
			})
		} else {
			try {
				await input.blobs.delete(
					rowsWithBlob.map((row) => row.raw_mime_key as string),
				)
				result.deletedRawMimeBlobs = rowsWithBlob.length
			} catch (error) {
				result.blobDeleteErrors = rowsWithBlob.length
				deletableRows = rows.filter((row) => row.raw_mime_key === null)
				console.warn('retention-email-raw-mime-delete-failed', { error })
			}
		}
	}
	const messageIds = deletableRows.map((row) => row.id)
	// email_attachments rows reference email_messages via FK, so delete the
	// dependent attachment rows first.
	result.deletedAttachments = await deleteByIds({
		db: input.db,
		table: 'email_attachments',
		idColumn: 'message_id',
		ids: messageIds,
	})
	result.deletedMessages = await deleteByIds({
		db: input.db,
		table: 'email_messages',
		idColumn: 'id',
		ids: messageIds,
	})
	const affectedUserIds = [...new Set(deletableRows.map((row) => row.user_id))]
	for (
		let index = 0;
		index < affectedUserIds.length;
		index += retentionDeleteIdsMaxParameters
	) {
		const userIds = affectedUserIds.slice(
			index,
			index + retentionDeleteIdsMaxParameters,
		)
		const threadDelete = await input.db
			.prepare(
				`DELETE FROM email_threads
				WHERE user_id IN (${placeholders(userIds)})
					AND NOT EXISTS (
						SELECT 1
						FROM email_messages
						WHERE email_messages.thread_id = email_threads.id
					)`,
			)
			.bind(...userIds)
			.run()
		result.deletedThreads += threadDelete.meta.changes ?? 0
	}
	// hasMore is based on the selected count: a full batch means more eligible
	// rows may follow even when some rows were skipped rather than deleted.
	// nextCursor points past every examined row so the next batch in this run
	// moves forward instead of reselecting the skipped head.
	const lastRow = rows.at(-1)
	result.hasMore = rows.length >= batchSize
	result.nextCursor =
		result.hasMore && lastRow
			? { createdAt: lastRow.created_at, id: lastRow.id }
			: null
	return result
}

export async function pruneEntitlementDailyCountersForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoffDay = cutoffIso(
		input.now ?? new Date(),
		entitlementDailyCounterRetentionDays,
	).slice(0, 'YYYY-MM-DD'.length)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [cutoffDay, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT rowid
			FROM entitlement_daily_counters
			WHERE day < ?
			ORDER BY day ASC, rowid ASC
			LIMIT ?`,
		table: 'entitlement_daily_counters',
		idColumn: 'rowid',
	})
}

export async function pruneUsageRollupsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const oldestKeptMonth = cutoffMonth(
		input.now ?? new Date(),
		usageRollupRetentionMonths,
	)
	return selectAndDeleteByIds({
		db: input.db,
		column: 'rowid',
		bindings: [oldestKeptMonth, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT rowid
			FROM usage_rollups
			WHERE month < ?
			ORDER BY month ASC, rowid ASC
			LIMIT ?`,
		table: 'usage_rollups',
		idColumn: 'rowid',
	})
}

export async function pruneAuditEventsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(input.now ?? new Date(), auditEventRetentionDays)
	return selectAndDeleteByIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM audit_events
			WHERE timestamp < ?
			ORDER BY timestamp ASC, id ASC
			LIMIT ?`,
		table: 'audit_events',
		idColumn: 'id',
	})
}

export async function pruneRetention(input: {
	// EMAIL_BLOBS stays optional so environments without the R2 binding still
	// prune everything else; blob-backed email rows are then skipped.
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'> & {
		EMAIL_BLOBS?: R2Bucket | undefined
	}
	now?: Date
	timeBudgetMs?: number
}): Promise<RetentionPruneResult> {
	const now = input.now ?? new Date()
	const timeBudgetMs = input.timeBudgetMs ?? retentionRunTimeBudgetMs
	const startedAtMs = Date.now()
	const db = input.env.APP_DB
	const emailBlobs = input.env.EMAIL_BLOBS
	// Per-run keyset cursor for the email prune; advances past rows skipped
	// for blob reasons so a blocked head cannot wedge later batches.
	let emailMessagesCursor: EmailMessageRetentionCursor | null = null
	const result: RetentionPruneResult = {
		runtimeRuns: { deletedRuns: 0, deletedLogs: 0, deletedOrphanLogs: 0 },
		packageInvocations: 0,
		memorySuppressions: 0,
		workflowRuns: 0,
		publishedBundleArtifacts: {
			deletedRows: 0,
			deletedKvKeys: 0,
			deletedSnapshotKvKeys: 0,
			kvDeleteErrors: 0,
		},
		emailDeliveryEvents: 0,
		emailMessages: {
			deletedMessages: 0,
			deletedAttachments: 0,
			deletedThreads: 0,
			deletedRawMimeBlobs: 0,
			skippedMissingBlobBinding: 0,
			blobDeleteErrors: 0,
		},
		entitlementDailyCounters: 0,
		usageRollups: 0,
		auditEvents: 0,
		batchesPerTable: {},
		timeBudgetExhausted: false,
	}
	const countTask = (
		table: string,
		prune: () => Promise<{ selected: number; deleted: number }>,
		assign: (deleted: number) => void,
	) => ({
		table,
		done: false,
		run: async () => {
			const batch = await prune()
			assign(batch.deleted)
			// hasMore keys off the selected count so a full batch that deleted
			// fewer rows (racing writers) does not mark the table drained early.
			return batch.selected >= retentionDefaultBatchSize
		},
	})
	const tasks: Array<{
		table: string
		done: boolean
		run: () => Promise<boolean>
	}> = [
		{
			table: 'package_runtime_runs',
			done: false,
			run: async () => {
				const batch = await prunePackageRuntimeRetention({ db, now })
				result.runtimeRuns.deletedRuns += batch.deletedRuns
				result.runtimeRuns.deletedLogs += batch.deletedLogs
				result.runtimeRuns.deletedOrphanLogs += batch.deletedOrphanLogs
				return batch.hasMore
			},
		},
		countTask(
			'package_invocations',
			() => prunePackageInvocationsForRetention({ db, now }),
			(count) => {
				result.packageInvocations += count
			},
		),
		countTask(
			'mcp_memory_conversation_suppressions',
			() => pruneMemorySuppressionsForRetention({ db, now }),
			(count) => {
				result.memorySuppressions += count
			},
		),
		countTask(
			'workflow_runs',
			() => pruneWorkflowRunsForRetention({ db, now }),
			(count) => {
				result.workflowRuns += count
			},
		),
		{
			table: 'published_bundle_artifacts',
			done: false,
			run: async () => {
				const batch = await prunePublishedBundleArtifactsForRetention({
					env: input.env,
					now,
				})
				result.publishedBundleArtifacts.deletedRows += batch.deletedRows
				result.publishedBundleArtifacts.deletedKvKeys += batch.deletedKvKeys
				result.publishedBundleArtifacts.deletedSnapshotKvKeys +=
					batch.deletedSnapshotKvKeys
				result.publishedBundleArtifacts.kvDeleteErrors += batch.kvDeleteErrors
				return batch.hasMore
			},
		},
		countTask(
			'email_delivery_events',
			() => pruneEmailDeliveryEventsForRetention({ db, now }),
			(count) => {
				result.emailDeliveryEvents += count
			},
		),
		{
			table: 'email_messages',
			done: false,
			run: async () => {
				const batch = await pruneUserEmailMessagesForRetention({
					db,
					blobs: emailBlobs,
					now,
					cursor: emailMessagesCursor,
				})
				result.emailMessages.deletedMessages += batch.deletedMessages
				result.emailMessages.deletedAttachments += batch.deletedAttachments
				result.emailMessages.deletedThreads += batch.deletedThreads
				result.emailMessages.deletedRawMimeBlobs += batch.deletedRawMimeBlobs
				result.emailMessages.skippedMissingBlobBinding +=
					batch.skippedMissingBlobBinding
				result.emailMessages.blobDeleteErrors += batch.blobDeleteErrors
				emailMessagesCursor = batch.nextCursor
				return batch.hasMore
			},
		},
		countTask(
			'entitlement_daily_counters',
			() => pruneEntitlementDailyCountersForRetention({ db, now }),
			(count) => {
				result.entitlementDailyCounters += count
			},
		),
		countTask(
			'usage_rollups',
			() => pruneUsageRollupsForRetention({ db, now }),
			(count) => {
				result.usageRollups += count
			},
		),
		countTask(
			'audit_events',
			() => pruneAuditEventsForRetention({ db, now }),
			(count) => {
				result.auditEvents += count
			},
		),
	]
	// Round-robin passes: every pending table gets one batch before any table
	// gets a second one, so a hot table cannot starve the others. The first
	// pass always completes so each table makes progress every run; later
	// passes stop once the time budget is exhausted.
	let pass = 0
	while (tasks.some((task) => !task.done)) {
		if (pass > 0 && Date.now() - startedAtMs >= timeBudgetMs) {
			result.timeBudgetExhausted = true
			break
		}
		for (const task of tasks) {
			if (task.done) continue
			if (pass > 0 && Date.now() - startedAtMs >= timeBudgetMs) break
			const hasMore = await task.run()
			result.batchesPerTable[task.table] =
				(result.batchesPerTable[task.table] ?? 0) + 1
			if (!hasMore) task.done = true
		}
		pass += 1
	}
	console.info('retention-prune', JSON.stringify(result))
	return result
}
