import { systemEmailOwnerId } from '#worker/email/system-email.ts'
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

export const packageRuntimeRunRetentionDays = 30
export const packageRuntimeMaxRunsPerPackage = 500
export const packageInvocationRetentionDays = 90
export const memorySuppressionRetentionDays = 90
export const workflowRunRetentionDays = 90
export const publishedBundleArtifactRetentionDays = 30
export const emailDeliveryEventRetentionDays = 90
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
			'Published bundle rows and KV blobs are deleted only when older than 30 days, not current for any source, and not tied to an active repo session.',
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
		kvDeleteErrors: number
	}
	emailDeliveryEvents: number
	auditEvents: number
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

export async function prunePackageRuntimeRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = cutoffIso(now, packageRuntimeRunRetentionDays)
	const batchSize = input.batchSize ?? retentionDefaultBatchSize
	const runIds = await selectIds({
		db: input.db,
		bindings: [cutoff, packageRuntimeMaxRunsPerPackage, batchSize],
		sql: `WITH ranked_runs AS (
				SELECT
					id,
					user_id,
					started_at,
					status,
					invocation_id,
					workflow_id,
					session_id,
					ROW_NUMBER() OVER (
						PARTITION BY user_id, package_id
						ORDER BY started_at DESC, id DESC
					) AS package_rank
				FROM package_runtime_runs
			)
			SELECT id
			FROM ranked_runs AS run
			WHERE (run.started_at < ? OR run.package_rank > ?)
				AND run.status != 'running'
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
				)
			ORDER BY run.started_at ASC, run.id ASC
			LIMIT ?`,
	})
	const deletedLogs = await deleteByIds({
		db: input.db,
		table: 'package_runtime_logs',
		idColumn: 'run_id',
		ids: runIds,
	})
	const deletedRuns = await deleteByIds({
		db: input.db,
		table: 'package_runtime_runs',
		idColumn: 'id',
		ids: runIds,
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
	return { deletedRuns, deletedLogs, deletedOrphanLogs }
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
	const ids = await selectIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM package_invocations
			WHERE created_at < ?
				AND status != 'in_progress'
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
	})
	return deleteByIds({
		db: input.db,
		table: 'package_invocations',
		idColumn: 'id',
		ids,
	})
}

export async function pruneMemorySuppressionsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = cutoffIso(now, memorySuppressionRetentionDays)
	const rowIds = await selectIds({
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
	})
	return deleteByIds({
		db: input.db,
		table: 'mcp_memory_conversation_suppressions',
		idColumn: 'rowid',
		ids: rowIds,
	})
}

export async function pruneWorkflowRunsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(input.now ?? new Date(), workflowRunRetentionDays)
	const ids = await selectIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM workflow_runs
			WHERE status IN (${terminalWorkflowStatusList})
				AND COALESCE(completed_at, updated_at, created_at) < ?
			ORDER BY COALESCE(completed_at, updated_at, created_at) ASC, id ASC
			LIMIT ?`,
	})
	return deleteByIds({
		db: input.db,
		table: 'workflow_runs',
		idColumn: 'id',
		ids,
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
	const { results } = await input.env.APP_DB.prepare(
		`SELECT artifact.id, artifact.kv_key
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
		.bind(cutoff, input.batchSize ?? publishedBundleArtifactRetentionBatchSize)
		.all<{ id: string; kv_key: string }>()
	const rows = results ?? []
	let deletedRows = 0
	let deletedKvKeys = 0
	let kvDeleteErrors = 0
	for (const row of rows) {
		const rowDeleted = await deletePublishedBundleArtifactRowIfStillStale({
			db: input.env.APP_DB,
			id: row.id,
			kvKey: row.kv_key,
			cutoff,
		})
		if (rowDeleted === 0) continue
		deletedRows += rowDeleted
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
	return { deletedRows, deletedKvKeys, kvDeleteErrors }
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
	const ids = await selectIds({
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
	})
	return deleteByIds({
		db: input.db,
		table: 'email_delivery_events',
		idColumn: 'id',
		ids,
	})
}

export async function pruneAuditEventsForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}) {
	const cutoff = cutoffIso(input.now ?? new Date(), auditEventRetentionDays)
	const ids = await selectIds({
		db: input.db,
		bindings: [cutoff, input.batchSize ?? retentionDefaultBatchSize],
		sql: `SELECT id
			FROM audit_events
			WHERE timestamp < ?
			ORDER BY timestamp ASC, id ASC
			LIMIT ?`,
	})
	return deleteByIds({
		db: input.db,
		table: 'audit_events',
		idColumn: 'id',
		ids,
	})
}

export async function pruneRetention(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	now?: Date
}): Promise<RetentionPruneResult> {
	const now = input.now ?? new Date()
	const result: RetentionPruneResult = {
		runtimeRuns: await prunePackageRuntimeRetention({
			db: input.env.APP_DB,
			now,
		}),
		packageInvocations: await prunePackageInvocationsForRetention({
			db: input.env.APP_DB,
			now,
		}),
		memorySuppressions: await pruneMemorySuppressionsForRetention({
			db: input.env.APP_DB,
			now,
		}),
		workflowRuns: await pruneWorkflowRunsForRetention({
			db: input.env.APP_DB,
			now,
		}),
		publishedBundleArtifacts: await prunePublishedBundleArtifactsForRetention({
			env: input.env,
			now,
		}),
		emailDeliveryEvents: await pruneEmailDeliveryEventsForRetention({
			db: input.env.APP_DB,
			now,
		}),
		auditEvents: await pruneAuditEventsForRetention({
			db: input.env.APP_DB,
			now,
		}),
	}
	console.info('retention-prune', JSON.stringify(result))
	return result
}
