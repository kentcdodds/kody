import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	auditEventRetentionDays,
	emailDeliveryEventRetentionDays,
	emailMessageRetentionDays,
	entitlementDailyCounterRetentionDays,
	getRetentionPolicyCoverage,
	memorySuppressionRetentionDays,
	packageInvocationRetentionDays,
	packageRuntimeRunRetentionDays,
	pruneAuditEventsForRetention,
	pruneEmailDeliveryEventsForRetention,
	pruneEntitlementDailyCountersForRetention,
	pruneMemorySuppressionsForRetention,
	prunePackageInvocationsForRetention,
	prunePackageRuntimeRetention,
	prunePublishedBundleArtifactsForRetention,
	pruneRetention,
	pruneUsageRollupsForRetention,
	pruneUserEmailMessagesForRetention,
	pruneWorkflowRunsForRetention,
	publishedBundleArtifactRetentionDays,
	shouldRunRetentionCron,
	workflowRunRetentionDays,
} from './retention.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	for (const fileName of readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDir), 'utf8'))
	}
}

function createD1FromSqlite(
	db: DatabaseSync,
	options?: { maxBindings?: number },
) {
	function assertBindingCount(params: Array<unknown>) {
		if (
			options?.maxBindings !== undefined &&
			params.length > options.maxBindings
		) {
			throw new Error(`too many SQL variables: ${params.length}`)
		}
	}
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					assertBindingCount(params)
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
				async all<T>() {
					const statement = db.prepare(query)
					const rows = statement.all() as Array<T>
					return { results: rows, meta: { changes: 0 } }
				},
				async first<T>() {
					const statement = db.prepare(query)
					return (statement.get() ?? null) as T | null
				},
				async run() {
					const statement = db.prepare(query)
					const result = statement.run()
					return { meta: { changes: result.changes } }
				},
			}
		},
	} as unknown as D1Database
}

function createRetentionDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE package_runtime_runs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			package_kody_id TEXT NOT NULL,
			source_id TEXT,
			published_commit TEXT,
			surface TEXT NOT NULL,
			name TEXT,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			duration_ms INTEGER,
			error_name TEXT,
			error_message TEXT,
			storage_id TEXT,
			job_id TEXT,
			workflow_id TEXT,
			invocation_id TEXT,
			session_id TEXT,
			idempotency_key TEXT,
			parent_run_id TEXT,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE package_runtime_logs (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			level TEXT NOT NULL,
			message TEXT NOT NULL,
			fields_json TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE package_invocations (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			token_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			package_kody_id TEXT NOT NULL,
			export_name TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			request_hash TEXT NOT NULL,
			source TEXT,
			topic TEXT,
			status TEXT NOT NULL,
			response_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE workflow_runs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_type TEXT NOT NULL,
			package_id TEXT,
			kody_id TEXT,
			source_id TEXT,
			workflow_name TEXT NOT NULL,
			export_name TEXT,
			idempotency_key TEXT NOT NULL,
			run_at TEXT NOT NULL,
			plan_date TEXT,
			status TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			last_error TEXT
		);
		CREATE TABLE repo_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE mcp_memory_conversation_suppressions (
			user_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			PRIMARY KEY (user_id, conversation_id, memory_id)
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			message_id TEXT,
			user_id TEXT NOT NULL,
			inbox_id TEXT,
			event_type TEXT NOT NULL,
			provider TEXT,
			provider_message_id TEXT,
			detail_json TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE email_threads (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			inbox_id TEXT,
			subject_normalized TEXT NOT NULL DEFAULT '',
			root_message_id_header TEXT,
			last_message_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			direction TEXT NOT NULL,
			user_id TEXT NOT NULL,
			inbox_id TEXT,
			thread_id TEXT,
			from_address TEXT NOT NULL,
			subject TEXT NOT NULL DEFAULT '',
			processing_status TEXT NOT NULL,
			raw_mime_key TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE email_attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			filename TEXT,
			content_type TEXT NOT NULL,
			size INTEGER NOT NULL DEFAULT 0,
			storage_kind TEXT NOT NULL,
			storage_key TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE entitlement_daily_counters (
			user_id TEXT NOT NULL,
			resource TEXT NOT NULL,
			day TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, resource, day)
		);
		CREATE TABLE usage_rollups (
			user_id TEXT NOT NULL,
			metric TEXT NOT NULL,
			month TEXT NOT NULL,
			event_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			total_duration_ms INTEGER NOT NULL DEFAULT 0,
			total_cpu_ms INTEGER NOT NULL DEFAULT 0,
			total_bytes INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, metric, month)
		);
		CREATE TABLE audit_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			category TEXT NOT NULL,
			action TEXT NOT NULL,
			result TEXT NOT NULL,
			email_hash TEXT,
			ip_hash TEXT,
			client_id TEXT,
			path TEXT,
			reason TEXT,
			timestamp TEXT NOT NULL
		);
	`)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

const now = new Date('2026-07-07T00:00:00.000Z')

function daysAgo(days: number) {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

function insertRuntimeRun(
	db: DatabaseSync,
	input: {
		id: string
		packageId?: string
		status?: string
		startedAt: string
		invocationId?: string | null
		workflowId?: string | null
		sessionId?: string | null
		parentRunId?: string | null
	},
) {
	db.prepare(
		`INSERT INTO package_runtime_runs (
			id, user_id, package_id, package_kody_id, surface, status, started_at,
			invocation_id, workflow_id, session_id, parent_run_id, created_at, updated_at
		) VALUES (?, 'user-1', ?, ?, 'export', ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.packageId ?? 'pkg-1',
		input.packageId ?? 'pkg-1',
		input.status ?? 'success',
		input.startedAt,
		input.invocationId ?? null,
		input.workflowId ?? null,
		input.sessionId ?? null,
		input.parentRunId ?? null,
		input.startedAt,
		input.startedAt,
	)
	db.prepare(
		`INSERT INTO package_runtime_logs (
			id, run_id, user_id, package_id, timestamp, sequence, level, message, created_at
		) VALUES (?, ?, 'user-1', ?, ?, 0, 'log', 'message', ?)`,
	).run(
		`log-${input.id}`,
		input.id,
		input.packageId ?? 'pkg-1',
		input.startedAt,
		input.startedAt,
	)
}

function insertEmailMessage(
	db: DatabaseSync,
	input: {
		id: string
		userId?: string
		threadId?: string | null
		rawMimeKey?: string | null
		createdAt: string
	},
) {
	db.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, thread_id, from_address, subject,
			processing_status, raw_mime_key, created_at, updated_at
		) VALUES (?, 'inbound', ?, ?, 'sender@example.net', 'Subject', 'stored', ?, ?, ?)`,
	).run(
		input.id,
		input.userId ?? 'user-1',
		input.threadId ?? null,
		input.rawMimeKey ?? null,
		input.createdAt,
		input.createdAt,
	)
}

function insertEmailThread(
	db: DatabaseSync,
	input: { id: string; userId?: string; createdAt: string },
) {
	db.prepare(
		`INSERT INTO email_threads (
			id, user_id, last_message_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.userId ?? 'user-1',
		input.createdAt,
		input.createdAt,
		input.createdAt,
	)
}

function insertPackageInvocation(
	db: DatabaseSync,
	input: { id: string; status?: string; createdAt: string },
) {
	db.prepare(
		`INSERT INTO package_invocations (
			id, user_id, token_id, package_id, package_kody_id, export_name,
			idempotency_key, request_hash, status, created_at, updated_at
		) VALUES (?, 'user-1', 'token', 'pkg-1', 'pkg-1', '.', ?, 'hash', ?, ?, ?)`,
	).run(
		input.id,
		`key-${input.id}`,
		input.status ?? 'completed',
		input.createdAt,
		input.createdAt,
	)
}

function idsForTable(db: DatabaseSync, table: string) {
	return (
		db.prepare(`SELECT id FROM ${table} ORDER BY id ASC`).all() as Array<{
			id: string
		}>
	).map((row) => row.id)
}

test('retention cron runs only on the hourly gate', () => {
	expect(shouldRunRetentionCron(new Date('2026-07-07T03:00:00.000Z'))).toBe(
		true,
	)
	expect(shouldRunRetentionCron(new Date('2026-07-07T03:05:00.000Z'))).toBe(
		false,
	)
})

test('runtime retention prunes old runs, caps per package, and keeps active references', async () => {
	const { sqlite, db } = createRetentionDb()
	const cutoff = daysAgo(packageRuntimeRunRetentionDays)
	insertRuntimeRun(sqlite, { id: 'old-delete', startedAt: daysAgo(31) })
	insertRuntimeRun(sqlite, { id: 'boundary-keep', startedAt: cutoff })
	insertRuntimeRun(sqlite, {
		id: 'running-keep',
		status: 'running',
		startedAt: daysAgo(31),
	})
	sqlite
		.prepare(
			`INSERT INTO package_invocations (
			id, user_id, token_id, package_id, package_kody_id, export_name,
			idempotency_key, request_hash, status, created_at, updated_at
		) VALUES ('inv-active', 'user-1', 'token', 'pkg-1', 'pkg-1', '.', 'key', 'hash', 'in_progress', ?, ?)`,
		)
		.run(daysAgo(31), daysAgo(31))
	insertRuntimeRun(sqlite, {
		id: 'invocation-keep',
		startedAt: daysAgo(31),
		invocationId: 'inv-active',
	})
	sqlite
		.prepare(
			`INSERT INTO workflow_runs (
			id, user_id, source_type, workflow_name, idempotency_key, run_at, status,
			created_at, updated_at
		) VALUES ('workflow-active', 'user-1', 'inline', 'wf', 'key', ?, 'running', ?, ?)`,
		)
		.run(daysAgo(31), daysAgo(31), daysAgo(31))
	insertRuntimeRun(sqlite, {
		id: 'workflow-keep',
		startedAt: daysAgo(31),
		workflowId: 'workflow-active',
	})
	sqlite
		.prepare(
			`INSERT INTO repo_sessions (
			id, user_id, source_id, status, created_at, updated_at
		) VALUES ('session-active', 'user-1', 'source-1', 'active', ?, ?)`,
		)
		.run(daysAgo(31), daysAgo(31))
	insertRuntimeRun(sqlite, {
		id: 'session-keep',
		startedAt: daysAgo(31),
		sessionId: 'session-active',
	})
	insertRuntimeRun(sqlite, { id: 'parent-keep', startedAt: daysAgo(31) })
	insertRuntimeRun(sqlite, {
		id: 'child-running',
		status: 'running',
		startedAt: daysAgo(1),
		parentRunId: 'parent-keep',
	})
	for (let index = 0; index < 502; index += 1) {
		insertRuntimeRun(sqlite, {
			id: `cap-${String(index).padStart(3, '0')}`,
			packageId: 'pkg-cap',
			startedAt: new Date(now.getTime() - index * 1000).toISOString(),
		})
	}
	sqlite
		.prepare(
			`INSERT INTO package_runtime_logs (
			id, run_id, user_id, package_id, timestamp, sequence, level, message, created_at
		) VALUES ('orphan-log', 'missing-run', 'user-1', 'pkg-1', ?, 0, 'log', 'orphan', ?)`,
		)
		.run(daysAgo(40), daysAgo(40))

	const result = await prunePackageRuntimeRetention({ db, now, batchSize: 20 })

	expect(result).toEqual({
		deletedRuns: 3,
		deletedLogs: 3,
		deletedOrphanLogs: 1,
		hasMore: false,
	})
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain('boundary-keep')
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain('running-keep')
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain(
		'invocation-keep',
	)
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain('workflow-keep')
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain('session-keep')
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain('parent-keep')
	expect(idsForTable(sqlite, 'package_runtime_runs')).not.toContain(
		'old-delete',
	)
	expect(idsForTable(sqlite, 'package_runtime_runs')).not.toContain('cap-500')
	expect(idsForTable(sqlite, 'package_runtime_runs')).not.toContain('cap-501')
	expect(idsForTable(sqlite, 'package_runtime_logs')).not.toContain(
		'orphan-log',
	)
})

test('runtime cap retention ranks bounded candidate pairs largest first', async () => {
	const { sqlite, db } = createRetentionDb()
	for (const [packageId, runCount] of [
		['pkg-large', 503],
		['pkg-small', 502],
	] as const) {
		for (let index = 0; index < runCount; index += 1) {
			insertRuntimeRun(sqlite, {
				id: `${packageId}-${String(index).padStart(3, '0')}`,
				packageId,
				startedAt: new Date(now.getTime() - index * 1000).toISOString(),
			})
		}
	}

	const first = await prunePackageRuntimeRetention({
		db,
		now,
		batchSize: 50,
		maxCapPairs: 1,
	})
	expect(first.deletedRuns).toBe(3)
	expect(first.hasMore).toBe(true)
	expect(idsForTable(sqlite, 'package_runtime_runs')).not.toContain(
		'pkg-large-502',
	)
	expect(idsForTable(sqlite, 'package_runtime_runs')).toContain('pkg-small-501')

	const second = await prunePackageRuntimeRetention({
		db,
		now,
		batchSize: 50,
		maxCapPairs: 1,
	})
	expect(second.deletedRuns).toBe(2)
	expect(idsForTable(sqlite, 'package_runtime_runs')).not.toContain(
		'pkg-small-501',
	)

	const third = await prunePackageRuntimeRetention({
		db,
		now,
		batchSize: 50,
		maxCapPairs: 1,
	})
	expect(third.deletedRuns).toBe(0)
	expect(third.hasMore).toBe(false)
})

test('package invocation and workflow retention keeps boundary and active idempotency rows', async () => {
	const { sqlite, db } = createRetentionDb()
	for (const [id, status, createdAt] of [
		[
			'inv-old-completed',
			'completed',
			daysAgo(packageInvocationRetentionDays + 1),
		],
		['inv-old-failed', 'failed', daysAgo(packageInvocationRetentionDays + 1)],
		['inv-boundary', 'completed', daysAgo(packageInvocationRetentionDays)],
		[
			'inv-in-progress',
			'in_progress',
			daysAgo(packageInvocationRetentionDays + 1),
		],
	]) {
		sqlite
			.prepare(
				`INSERT INTO package_invocations (
				id, user_id, token_id, package_id, package_kody_id, export_name,
				idempotency_key, request_hash, status, response_json, created_at, updated_at
			) VALUES (?, 'user-1', 'token', 'pkg-1', 'pkg-1', '.', ?, 'hash', ?, '{}', ?, ?)`,
			)
			.run(id, id, status, createdAt, createdAt)
	}
	for (const [id, status, completedAt] of [
		[
			'workflow-old-complete',
			'complete',
			daysAgo(workflowRunRetentionDays + 1),
		],
		['workflow-old-errored', 'errored', daysAgo(workflowRunRetentionDays + 1)],
		['workflow-boundary', 'complete', daysAgo(workflowRunRetentionDays)],
		['workflow-running', 'running', daysAgo(workflowRunRetentionDays + 1)],
		['workflow-unknown', null, daysAgo(workflowRunRetentionDays + 1)],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO workflow_runs (
				id, user_id, source_type, workflow_name, idempotency_key, run_at, status,
				created_at, updated_at, completed_at
			) VALUES (?, 'user-1', 'inline', 'wf', ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, id, completedAt, status, completedAt, completedAt, completedAt)
	}

	expect(await prunePackageInvocationsForRetention({ db, now })).toEqual({
		selected: 2,
		deleted: 2,
	})
	expect(await pruneWorkflowRunsForRetention({ db, now })).toEqual({
		selected: 2,
		deleted: 2,
	})

	expect(idsForTable(sqlite, 'package_invocations')).toEqual([
		'inv-boundary',
		'inv-in-progress',
	])
	expect(idsForTable(sqlite, 'workflow_runs')).toEqual([
		'workflow-boundary',
		'workflow-running',
		'workflow-unknown',
	])
})

test('memory suppression, email delivery, and audit retention respect boundaries', async () => {
	const { sqlite, db } = createRetentionDb()
	for (const [memoryId, lastSeenAt, expiresAt] of [
		[
			'memory-old-expired',
			daysAgo(memorySuppressionRetentionDays + 1),
			daysAgo(1),
		],
		['memory-boundary', daysAgo(memorySuppressionRetentionDays), daysAgo(1)],
		['memory-active', daysAgo(memorySuppressionRetentionDays + 1), daysAgo(-1)],
	]) {
		sqlite
			.prepare(
				`INSERT INTO mcp_memory_conversation_suppressions (
				user_id, conversation_id, memory_id, created_at, last_seen_at, expires_at
			) VALUES ('user-1', 'conversation', ?, ?, ?, ?)`,
			)
			.run(memoryId, lastSeenAt, lastSeenAt, expiresAt)
	}
	for (const [id, userId, createdAt] of [
		['email-old-user', 'user-1', daysAgo(emailDeliveryEventRetentionDays + 1)],
		['email-boundary-user', 'user-1', daysAgo(emailDeliveryEventRetentionDays)],
		[
			'email-old-system',
			systemEmailOwnerId,
			daysAgo(emailDeliveryEventRetentionDays + 1),
		],
	]) {
		sqlite
			.prepare(
				`INSERT INTO email_delivery_events (
				id, user_id, event_type, created_at
			) VALUES (?, ?, 'received', ?)`,
			)
			.run(id, userId, createdAt)
	}
	for (const [timestamp] of [
		[daysAgo(auditEventRetentionDays + 1)],
		[daysAgo(auditEventRetentionDays)],
	]) {
		sqlite
			.prepare(
				`INSERT INTO audit_events (
				category, action, result, timestamp
			) VALUES ('auth', 'login', 'success', ?)`,
			)
			.run(timestamp)
	}

	expect(await pruneMemorySuppressionsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(await pruneEmailDeliveryEventsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(await pruneAuditEventsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})

	const memories = sqlite
		.prepare(
			`SELECT memory_id
			FROM mcp_memory_conversation_suppressions
			ORDER BY memory_id`,
		)
		.all() as Array<{ memory_id: string }>
	expect(memories.map((row) => row.memory_id)).toEqual([
		'memory-active',
		'memory-boundary',
	])
	expect(idsForTable(sqlite, 'email_delivery_events')).toEqual([
		'email-boundary-user',
		'email-old-system',
	])
	const auditRows = sqlite
		.prepare(`SELECT timestamp FROM audit_events ORDER BY timestamp`)
		.all() as Array<{ timestamp: string }>
	expect(auditRows.map((row) => row.timestamp)).toEqual([
		daysAgo(auditEventRetentionDays),
	])
})

test('email message retention deletes old user rows, R2 blobs, attachments, and orphan threads', async () => {
	const { sqlite, db } = createRetentionDb()
	insertEmailThread(sqlite, {
		id: 'thread-orphan',
		createdAt: daysAgo(emailMessageRetentionDays + 2),
	})
	insertEmailThread(sqlite, {
		id: 'thread-mixed',
		createdAt: daysAgo(emailMessageRetentionDays + 2),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-old-blob',
		threadId: 'thread-orphan',
		rawMimeKey: 'raw-mime/user-1/msg-old-blob',
		createdAt: daysAgo(emailMessageRetentionDays + 1),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-old-plain',
		threadId: 'thread-mixed',
		createdAt: daysAgo(emailMessageRetentionDays + 1),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-fresh',
		threadId: 'thread-mixed',
		createdAt: daysAgo(1),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-boundary',
		createdAt: daysAgo(emailMessageRetentionDays),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-old-system',
		userId: systemEmailOwnerId,
		createdAt: daysAgo(emailMessageRetentionDays + 1),
	})
	sqlite
		.prepare(
			`INSERT INTO email_attachments (
			id, message_id, content_type, size, storage_kind, created_at
		) VALUES ('att-old', 'msg-old-blob', 'text/plain', 1, 'raw-mime', ?)`,
		)
		.run(daysAgo(emailMessageRetentionDays + 1))
	const blobDelete = vi.fn(async () => undefined)

	const result = await pruneUserEmailMessagesForRetention({
		db,
		blobs: { delete: blobDelete } as unknown as Pick<R2Bucket, 'delete'>,
		now,
	})

	expect(result).toEqual({
		deletedMessages: 2,
		deletedAttachments: 1,
		deletedThreads: 1,
		deletedRawMimeBlobs: 1,
		blobDeleteErrors: 0,
		hasMore: false,
		nextCursor: null,
	})
	expect(blobDelete).toHaveBeenCalledWith(['raw-mime/user-1/msg-old-blob'])
	expect(idsForTable(sqlite, 'email_messages')).toEqual([
		'msg-boundary',
		'msg-fresh',
		'msg-old-system',
	])
	expect(idsForTable(sqlite, 'email_attachments')).toEqual([])
	expect(idsForTable(sqlite, 'email_threads')).toEqual(['thread-mixed'])
})

test('email message retention never deletes rows whose blob cannot be deleted first', async () => {
	const { sqlite, db } = createRetentionDb()
	insertEmailMessage(sqlite, {
		id: 'msg-old-blob',
		rawMimeKey: 'raw-mime/user-1/msg-old-blob',
		createdAt: daysAgo(emailMessageRetentionDays + 1),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-old-plain',
		createdAt: daysAgo(emailMessageRetentionDays + 1),
	})

	const failingDelete = vi.fn(async () => {
		throw new Error('r2 unavailable')
	})
	const failedDelete = await pruneUserEmailMessagesForRetention({
		db,
		blobs: { delete: failingDelete } as unknown as Pick<R2Bucket, 'delete'>,
		now,
	})
	expect(failedDelete).toMatchObject({
		deletedMessages: 1,
		deletedRawMimeBlobs: 0,
		blobDeleteErrors: 1,
	})
	expect(idsForTable(sqlite, 'email_messages')).toEqual(['msg-old-blob'])

	const workingDelete = vi.fn(async () => undefined)
	const succeeded = await pruneUserEmailMessagesForRetention({
		db,
		blobs: { delete: workingDelete } as unknown as Pick<R2Bucket, 'delete'>,
		now,
	})
	expect(succeeded).toMatchObject({
		deletedMessages: 1,
		deletedRawMimeBlobs: 1,
	})
	expect(idsForTable(sqlite, 'email_messages')).toEqual([])
})

test('email message retention cursor advances past skipped blob rows at the head', async () => {
	const { sqlite, db } = createRetentionDb()
	// The two oldest expired rows are blob-backed and unpassable while the
	// R2 delete fails; the two plain expired rows behind them must still be
	// pruned within the same run.
	insertEmailMessage(sqlite, {
		id: 'msg-blocked-a',
		rawMimeKey: 'raw-mime/user-1/msg-blocked-a',
		createdAt: daysAgo(emailMessageRetentionDays + 4),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-blocked-b',
		rawMimeKey: 'raw-mime/user-1/msg-blocked-b',
		createdAt: daysAgo(emailMessageRetentionDays + 3),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-plain-a',
		createdAt: daysAgo(emailMessageRetentionDays + 2),
	})
	insertEmailMessage(sqlite, {
		id: 'msg-plain-b',
		createdAt: daysAgo(emailMessageRetentionDays + 1),
	})
	const failingBlobs = {
		delete: vi.fn(async () => {
			throw new Error('r2 unavailable')
		}),
	} as unknown as Pick<R2Bucket, 'delete'>

	const first = await pruneUserEmailMessagesForRetention({
		db,
		blobs: failingBlobs,
		now,
		batchSize: 2,
	})
	// Full batch selected but nothing deleted: hasMore must stay true and the
	// cursor must point past the skipped rows.
	expect(first).toMatchObject({
		deletedMessages: 0,
		blobDeleteErrors: 2,
		hasMore: true,
	})
	expect(first.nextCursor).toEqual({
		createdAt: daysAgo(emailMessageRetentionDays + 3),
		id: 'msg-blocked-b',
	})

	const second = await pruneUserEmailMessagesForRetention({
		db,
		blobs: failingBlobs,
		now,
		batchSize: 2,
		cursor: first.nextCursor,
	})
	expect(second).toMatchObject({
		deletedMessages: 2,
		blobDeleteErrors: 0,
		hasMore: true,
	})
	expect(idsForTable(sqlite, 'email_messages')).toEqual([
		'msg-blocked-a',
		'msg-blocked-b',
	])

	const third = await pruneUserEmailMessagesForRetention({
		db,
		blobs: failingBlobs,
		now,
		batchSize: 2,
		cursor: second.nextCursor,
	})
	expect(third).toMatchObject({ deletedMessages: 0, hasMore: false })
})

test('retention run prunes expired plain emails behind a skipped blob-row head', async () => {
	const { sqlite, db } = createRetentionDb()
	// 251 blob-backed rows fill the first default-size batch and spill into the
	// second; 5 plain expired rows sit behind them.
	for (let index = 0; index < 251; index += 1) {
		insertEmailMessage(sqlite, {
			id: `msg-blob-${String(index).padStart(3, '0')}`,
			rawMimeKey: `raw-mime/user-1/${index}`,
			createdAt: new Date(
				now.getTime() -
					(emailMessageRetentionDays + 10) * 24 * 60 * 60 * 1000 +
					index * 1000,
			).toISOString(),
		})
	}
	for (let index = 0; index < 5; index += 1) {
		insertEmailMessage(sqlite, {
			id: `msg-plain-${index}`,
			createdAt: daysAgo(emailMessageRetentionDays + 1),
		})
	}
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: {
			delete: vi.fn(async () => {
				throw new Error('r2 unavailable')
			}),
		},
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'>

	// Every blob delete fails, so every blob row is skipped, yet the
	// run-level cursor advances past them so the plain rows in the second
	// batch are still pruned within the same run.
	const result = await pruneRetention({ env, now })

	expect(result.emailMessages.deletedMessages).toBe(5)
	expect(result.emailMessages.blobDeleteErrors).toBe(251)
	expect(result.batchesPerTable['email_messages']).toBe(2)
	expect(idsForTable(sqlite, 'email_messages')).toHaveLength(251)
	expect(idsForTable(sqlite, 'email_messages')).not.toContain('msg-plain-0')
})

test('retention prune reports selected separately from deleted when rows vanish mid-batch', async () => {
	const { sqlite } = createRetentionDb()
	const baseDb = createD1FromSqlite(sqlite)
	// Simulate a racing writer deleting one selected row before the batch
	// DELETE runs: selected stays at the full batch size so hasMore-style
	// decisions keep looping instead of marking the table drained.
	const dbWithVanishingRow = {
		prepare(query: string) {
			const prepared = baseDb.prepare(query)
			if (!query.includes('DELETE FROM package_invocations')) return prepared
			return {
				bind(...params: Array<unknown>) {
					const bound = prepared.bind(...params)
					return {
						async run() {
							sqlite
								.prepare(`DELETE FROM package_invocations WHERE id = 'inv-0'`)
								.run()
							return bound.run()
						},
						all: bound.all,
						first: bound.first,
					}
				},
			}
		},
	} as unknown as D1Database
	for (let index = 0; index < 2; index += 1) {
		insertPackageInvocation(sqlite, {
			id: `inv-${index}`,
			createdAt: daysAgo(120),
		})
	}

	expect(
		await prunePackageInvocationsForRetention({
			db: dbWithVanishingRow,
			now,
			batchSize: 2,
		}),
	).toEqual({ selected: 2, deleted: 1 })
})

test('entitlement counter and usage rollup retention respect boundaries', async () => {
	const { sqlite, db } = createRetentionDb()
	const cutoffDay = daysAgo(entitlementDailyCounterRetentionDays).slice(0, 10)
	for (const day of [
		daysAgo(entitlementDailyCounterRetentionDays + 1).slice(0, 10),
		cutoffDay,
		daysAgo(1).slice(0, 10),
	]) {
		sqlite
			.prepare(
				`INSERT INTO entitlement_daily_counters (
				user_id, resource, day, count, updated_at
			) VALUES ('user-1', 'email_sends_per_day', ?, 1, ?)`,
			)
			.run(day, now.toISOString())
	}
	// 24 months before 2026-07 keeps 2024-07 and later.
	for (const month of ['2024-06', '2024-07', '2026-06']) {
		sqlite
			.prepare(
				`INSERT INTO usage_rollups (
				user_id, metric, month, event_count, updated_at
			) VALUES ('user-1', 'mcp_tool_call', ?, 1, ?)`,
			)
			.run(month, now.toISOString())
	}

	expect(await pruneEntitlementDailyCountersForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})
	expect(await pruneUsageRollupsForRetention({ db, now })).toEqual({
		selected: 1,
		deleted: 1,
	})

	const days = sqlite
		.prepare(`SELECT day FROM entitlement_daily_counters ORDER BY day`)
		.all() as Array<{ day: string }>
	expect(days.map((row) => row.day)).toEqual([
		cutoffDay,
		daysAgo(1).slice(0, 10),
	])
	const months = sqlite
		.prepare(`SELECT month FROM usage_rollups ORDER BY month`)
		.all() as Array<{ month: string }>
	expect(months.map((row) => row.month)).toEqual(['2024-07', '2026-06'])
})

test('published bundle artifact retention deletes stale rows, KV blobs, and source snapshots', async () => {
	const { sqlite, db } = createRetentionDb()
	const kvDelete = vi.fn(async () => undefined)
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: {
			delete: kvDelete,
		},
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	for (const [sourceId, publishedCommit] of [
		['source-current', 'commit-current'],
		['source-stale', 'commit-current'],
		['source-session', 'commit-current'],
	]) {
		sqlite
			.prepare(
				`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES (?, 'user-1', 'package', ?, ?, ?, ?, ?)`,
			)
			.run(
				sourceId,
				`pkg-${sourceId}`,
				`repo-${sourceId}`,
				publishedCommit,
				daysAgo(60),
				daysAgo(60),
			)
	}
	sqlite
		.prepare(
			`INSERT INTO repo_sessions (
			id, user_id, source_id, status, created_at, updated_at
		) VALUES ('session-1', 'user-1', 'source-session', 'active', ?, ?)`,
		)
		.run(daysAgo(1), daysAgo(1))
	for (const [id, sourceId, commit, createdAt] of [
		[
			'artifact-delete',
			'source-stale',
			'commit-old',
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		],
		[
			'artifact-current',
			'source-current',
			'commit-current',
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		],
		[
			'artifact-fresh',
			'source-stale',
			'commit-old',
			daysAgo(publishedBundleArtifactRetentionDays),
		],
		[
			'artifact-session',
			'source-session',
			'commit-old',
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		],
	]) {
		sqlite
			.prepare(
				`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, entry_point,
				kv_key, created_at, updated_at
			) VALUES (?, 'user-1', ?, ?, 'module', 'src/index.ts', ?, ?, ?)`,
			)
			.run(id, sourceId, commit, `kv:${id}`, createdAt, createdAt)
	}

	const result = await prunePublishedBundleArtifactsForRetention({
		env,
		now,
		batchSize: 10,
	})

	expect(result).toEqual({
		deletedRows: 1,
		deletedKvKeys: 1,
		deletedSnapshotKvKeys: 2,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(kvDelete).toHaveBeenCalledWith('kv:artifact-delete')
	expect(kvDelete).toHaveBeenCalledWith(
		'source-snapshot:v1:source-stale:commit-old',
	)
	expect(kvDelete).toHaveBeenCalledWith(
		'source-manifest-snapshot:v1:source-stale:commit-old',
	)
	expect(idsForTable(sqlite, 'published_bundle_artifacts')).toEqual([
		'artifact-current',
		'artifact-fresh',
		'artifact-session',
	])
})

test('published bundle artifact retention rechecks staleness before deleting selected rows', async () => {
	const { sqlite } = createRetentionDb()
	const baseDb = createD1FromSqlite(sqlite)
	const kvDelete = vi.fn(async () => undefined)
	let refreshedBeforeDelete = false
	const dbWithRefreshRace = {
		prepare(query: string) {
			const prepared = baseDb.prepare(query)
			if (
				query.includes('DELETE FROM published_bundle_artifacts') &&
				query.includes('AND kv_key = ?')
			) {
				return {
					bind(...params: Array<unknown>) {
						const bound = prepared.bind(...params)
						return {
							async run() {
								refreshedBeforeDelete = true
								sqlite
									.prepare(
										`UPDATE entity_sources
										SET published_commit = 'commit-old'
										WHERE id = 'source-race'`,
									)
									.run()
								return bound.run()
							},
							all: bound.all,
							first: bound.first,
						}
					},
				}
			}
			return prepared
		},
	} as unknown as D1Database
	const env = {
		APP_DB: dbWithRefreshRace,
		BUNDLE_ARTIFACTS_KV: {
			delete: kvDelete,
		},
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	sqlite
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				created_at, updated_at
			) VALUES ('source-race', 'user-1', 'package', 'pkg-race', 'repo-race',
				'commit-current', ?, ?)`,
		)
		.run(daysAgo(60), daysAgo(60))
	sqlite
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, entry_point,
				kv_key, created_at, updated_at
			) VALUES (
				'artifact-race', 'user-1', 'source-race', 'commit-old', 'module',
				'src/index.ts', 'kv:artifact-race', ?, ?
			)`,
		)
		.run(
			daysAgo(publishedBundleArtifactRetentionDays + 1),
			daysAgo(publishedBundleArtifactRetentionDays + 1),
		)

	const result = await prunePublishedBundleArtifactsForRetention({
		env,
		now,
		batchSize: 10,
	})

	expect(refreshedBeforeDelete).toBe(true)
	expect(result).toEqual({
		deletedRows: 0,
		deletedKvKeys: 0,
		deletedSnapshotKvKeys: 0,
		kvDeleteErrors: 0,
		hasMore: false,
	})
	expect(kvDelete).not.toHaveBeenCalled()
	expect(idsForTable(sqlite, 'published_bundle_artifacts')).toEqual([
		'artifact-race',
	])
})

test('retention pruning deletes only one configured batch per table invocation', async () => {
	const { sqlite, db } = createRetentionDb()
	for (let index = 0; index < 3; index += 1) {
		sqlite
			.prepare(
				`INSERT INTO package_invocations (
				id, user_id, token_id, package_id, package_kody_id, export_name,
				idempotency_key, request_hash, status, created_at, updated_at
			) VALUES (?, 'user-1', 'token', 'pkg-1', 'pkg-1', '.', ?, 'hash', 'completed', ?, ?)`,
			)
			.run(`inv-${index}`, `key-${index}`, daysAgo(120), daysAgo(120))
	}

	expect(
		await prunePackageInvocationsForRetention({ db, now, batchSize: 2 }),
	).toEqual({ selected: 2, deleted: 2 })
	expect(idsForTable(sqlite, 'package_invocations')).toEqual(['inv-2'])
	expect(
		await prunePackageInvocationsForRetention({ db, now, batchSize: 2 }),
	).toEqual({ selected: 1, deleted: 1 })
	expect(idsForTable(sqlite, 'package_invocations')).toEqual([])
})

test('retention row deletes chunk ids to stay within the D1 binding limit', async () => {
	const { sqlite } = createRetentionDb()
	const db = createD1FromSqlite(sqlite, { maxBindings: 100 })
	for (let index = 0; index < 101; index += 1) {
		sqlite
			.prepare(
				`INSERT INTO package_invocations (
					id, user_id, token_id, package_id, package_kody_id, export_name,
					idempotency_key, request_hash, status, created_at, updated_at
				) VALUES (?, 'user-1', 'token', 'pkg-1', 'pkg-1', '.', ?, 'hash',
					'completed', ?, ?)`,
			)
			.run(`inv-${index}`, `key-${index}`, daysAgo(120), daysAgo(120))
	}

	expect(
		await prunePackageInvocationsForRetention({ db, now, batchSize: 101 }),
	).toEqual({ selected: 101, deleted: 101 })
	expect(idsForTable(sqlite, 'package_invocations')).toEqual([])
})

test('retention run loops batches per table until backlogs are drained', async () => {
	const { sqlite, db } = createRetentionDb()
	for (let index = 0; index < 501; index += 1) {
		insertPackageInvocation(sqlite, {
			id: `inv-${String(index).padStart(3, '0')}`,
			createdAt: daysAgo(120),
		})
	}
	for (let index = 0; index < 300; index += 1) {
		sqlite
			.prepare(
				`INSERT INTO audit_events (
				category, action, result, timestamp
			) VALUES ('auth', 'login', 'success', ?)`,
			)
			.run(daysAgo(auditEventRetentionDays + 1))
	}
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'>

	const result = await pruneRetention({ env, now })

	expect(result.packageInvocations).toBe(501)
	expect(result.auditEvents).toBe(300)
	expect(result.batchesPerTable['package_invocations']).toBe(3)
	expect(result.batchesPerTable['audit_events']).toBe(2)
	expect(result.timeBudgetExhausted).toBe(false)
	expect(idsForTable(sqlite, 'package_invocations')).toEqual([])
})

test('retention run gives every table one batch and stops when the budget is exhausted', async () => {
	const { sqlite, db } = createRetentionDb()
	for (let index = 0; index < 300; index += 1) {
		insertPackageInvocation(sqlite, {
			id: `inv-${String(index).padStart(3, '0')}`,
			createdAt: daysAgo(120),
		})
	}
	sqlite
		.prepare(
			`INSERT INTO audit_events (
			category, action, result, timestamp
		) VALUES ('auth', 'login', 'success', ?)`,
		)
		.run(daysAgo(auditEventRetentionDays + 1))
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: { delete: vi.fn(async () => undefined) },
		EMAIL_BLOBS: { delete: vi.fn(async () => undefined) },
	} as unknown as Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'EMAIL_BLOBS'>

	const result = await pruneRetention({ env, now, timeBudgetMs: 0 })

	// The first round-robin pass always completes so a hot table cannot starve
	// the others, then the exhausted budget stops further passes.
	expect(result.packageInvocations).toBe(250)
	expect(result.auditEvents).toBe(1)
	expect(result.batchesPerTable['package_invocations']).toBe(1)
	expect(result.timeBudgetExhausted).toBe(true)
	expect(idsForTable(sqlite, 'package_invocations')).toHaveLength(50)
})

test('retention coverage includes every live growth-pattern table or documented exemption', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrations(db)
	const tables = db
		.prepare(
			`SELECT name
			FROM sqlite_schema
			WHERE type = 'table'
				AND name NOT LIKE 'sqlite_%'
			ORDER BY name`,
		)
		.all() as Array<{ name: string }>
	const candidateTables = new Set<string>()
	const growthPattern =
		/(?:_runs|_logs|_events|_invocations|_suppressions|_artifacts|_messages|_threads|_attachments|_rollups|_counters|_memories)$/u
	const growthTimeColumns = ['created_at', 'day', 'month']
	for (const table of tables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
			.all() as Array<{ name: string }>
		const columnNames = new Set(columns.map((column) => column.name))
		const hasUserCreatedGrowthShape =
			columnNames.has('user_id') &&
			growthTimeColumns.some((column) => columnNames.has(column)) &&
			growthPattern.test(table.name)
		const hasGlobalAuditShape =
			table.name === 'audit_events' && columnNames.has('timestamp')
		if (hasUserCreatedGrowthShape || hasGlobalAuditShape) {
			candidateTables.add(table.name)
		}
	}
	const covered = getRetentionPolicyCoverage()
	const missing = [...candidateTables].filter((table) => !covered.has(table))
	const stale = [...covered].filter(
		(table) =>
			!candidateTables.has(table) && !tables.some((row) => row.name === table),
	)

	expect(missing).toEqual([])
	expect(stale).toEqual([])
})
