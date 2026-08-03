import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
	systemEmailAuthorityMigration,
	systemEmailGraphMigration,
} from '#worker/test-support/system-email-graph-migration.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { systemEmailGraphColumnContracts } from './system-email-graph-columns.ts'
import {
	claimSystemInboundSubscriptionEffect,
	completeSystemInboundSubscriptionEffect,
	listDueSystemInboundEffects,
} from './system-inbound-effect-store.ts'
import {
	pruneSystemExpiredInboundDedupePointers,
	reconcileSystemStaleInboundDeliveries,
} from './system-inbound-delivery-store.ts'

type TableInfoColumn = {
	name: string
	type: string
	notnull: number
	dflt_value: string | null
	pk: number
}

type ComparableColumn = {
	name: string
	type: string
	notnull: number
	defaultValue: string | null
	pk: number
}

type DocumentedColumnDifference = {
	table: string
	column: string
	field: Exclude<keyof ComparableColumn, 'name'>
	dedicatedValue: string | number | null
	reason: string
}

type ForeignKeyRow = {
	table: string
	from: string
	to: string
	on_update: string
	on_delete: string
	match: string
}

type ComparableForeignKey = {
	from: string
	toTable: string
	to: string
	onUpdate: string
	onDelete: string
	match: string
}

/**
 * Dedicated graph columns intentionally match canonical legacy metadata after
 * removing user_id. Any future exception must be added here with a reason.
 */
const documentedColumnDifferences: ReadonlyArray<DocumentedColumnDifference> =
	[]

function tableColumns(
	db: DatabaseSync,
	table: string,
): Array<ComparableColumn> {
	return (
		db.prepare(`PRAGMA table_info(${table})`).all() as Array<TableInfoColumn>
	).map((column) => ({
		name: column.name,
		type: column.type,
		notnull: column.notnull,
		defaultValue: column.dflt_value,
		pk: column.pk,
	}))
}

function expectedDedicatedColumns(
	legacyColumns: ReadonlyArray<ComparableColumn>,
	dedicatedTable: string,
): Array<ComparableColumn> {
	return legacyColumns
		.filter((column) => column.name !== 'user_id')
		.map((column) => {
			const expected = { ...column }
			for (const difference of documentedColumnDifferences) {
				if (
					difference.table === dedicatedTable &&
					difference.column === column.name
				) {
					Object.assign(expected, {
						[difference.field]: difference.dedicatedValue,
					})
				}
			}
			return expected
		})
}

function foreignKeys(
	db: DatabaseSync,
	table: string,
): Array<ComparableForeignKey> {
	return (
		db
			.prepare(`PRAGMA foreign_key_list(${table})`)
			.all() as Array<ForeignKeyRow>
	)
		.map((foreignKey) => ({
			from: foreignKey.from,
			toTable: foreignKey.table,
			to: foreignKey.to,
			onUpdate: foreignKey.on_update,
			onDelete: foreignKey.on_delete,
			match: foreignKey.match,
		}))
		.sort((left, right) => left.from.localeCompare(right.from))
}

function assertForeignKeys(
	db: DatabaseSync,
	table: string,
	expected: ReadonlyArray<ComparableForeignKey>,
) {
	expect(
		foreignKeys(db, table),
		`${table} foreign-key target/action drift. Update this explicit contract only for an intentional graph relationship change.`,
	).toEqual(expected)
}

function normalizeSchemaSql(sql: string): string {
	return sql
		.replaceAll(/\s+/gu, ' ')
		.replaceAll(/\(\s+/gu, '(')
		.replaceAll(/\s+\)/gu, ')')
		.trim()
		.toLowerCase()
}

function assertTableChecks(
	db: DatabaseSync,
	table: string,
	checks: ReadonlyArray<{ label: string; sql: string }>,
) {
	const row = db
		.prepare(
			`SELECT sql
			FROM sqlite_master
			WHERE type = 'table' AND name = ?`,
		)
		.get(table) as { sql: string } | undefined
	expect(
		row,
		`Missing sqlite_master CREATE TABLE SQL for ${table}`,
	).toBeDefined()
	const actualSql = normalizeSchemaSql(row?.sql ?? '')
	for (const check of checks) {
		const expectedSql = normalizeSchemaSql(check.sql)
		expect(
			actualSql,
			`${table} CHECK drift for ${check.label}\nExpected fragment: ${expectedSql}\nActual SQL: ${actualSql}`,
		).toContain(expectedSql)
	}
}

function graphParityDifferenceCount(
	db: DatabaseSync,
	contract: (typeof systemEmailGraphColumnContracts)[number],
) {
	const dedicatedColumns = contract.columns
		.map((column) => `dedicated.${column}`)
		.join(', ')
	const legacyColumns = contract.columns
		.map((column) => `legacy.${column}`)
		.join(', ')
	const legacy =
		contract.key === 'attachments'
			? `SELECT ${legacyColumns}
				FROM email_attachments legacy
				INNER JOIN email_messages owner ON owner.id = legacy.message_id
				WHERE owner.user_id = ?`
			: `SELECT ${legacyColumns}
				FROM ${contract.legacyTable} legacy
				WHERE legacy.user_id = ?`
	const dedicated = `SELECT ${dedicatedColumns}
		FROM ${contract.dedicatedTable} dedicated`
	const difference = (left: string, right: string) =>
		(
			db
				.prepare(`SELECT COUNT(*) AS count FROM (${left} EXCEPT ${right})`)
				.get(systemEmailOwnerId) as { count: number }
		).count
	return difference(legacy, dedicated) + difference(dedicated, legacy)
}

test('0130 dedicated schema matches canonical metadata, FKs, and checks', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailGraphMigration)
	applyMigrationLikeD1(db, systemEmailGraphMigration)

	for (const contract of systemEmailGraphColumnContracts) {
		const legacyColumns = tableColumns(db, contract.legacyTable)
		const dedicatedColumns = tableColumns(db, contract.dedicatedTable)
		const expectedColumns = expectedDedicatedColumns(
			legacyColumns,
			contract.dedicatedTable,
		)
		expect(
			dedicatedColumns,
			`${contract.dedicatedTable} PRAGMA table_info drifted from ${contract.legacyTable} minus user_id.\nDocument intentional metadata differences in documentedColumnDifferences.`,
		).toEqual(expectedColumns)
		expect(
			dedicatedColumns.map((column) => column.name),
			`${contract.dedicatedTable} diverged from its exported copy/compare column contract.`,
		).toEqual(contract.columns)
	}
	const noAction = 'NO ACTION'
	const noMatch = 'NONE'
	assertForeignKeys(db, 'system_email_threads', [
		{
			from: 'inbox_id',
			toTable: 'email_inboxes',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'SET NULL',
			match: noMatch,
		},
	])
	assertForeignKeys(db, 'system_email_messages', [
		{
			from: 'inbox_id',
			toTable: 'email_inboxes',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'SET NULL',
			match: noMatch,
		},
		{
			from: 'sender_identity_id',
			toTable: 'email_sender_identities',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'SET NULL',
			match: noMatch,
		},
		{
			from: 'thread_id',
			toTable: 'system_email_threads',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'SET NULL',
			match: noMatch,
		},
	])
	assertForeignKeys(db, 'system_email_attachments', [
		{
			from: 'message_id',
			toTable: 'system_email_messages',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'CASCADE',
			match: noMatch,
		},
	])
	assertForeignKeys(db, 'system_email_delivery_events', [
		{
			from: 'inbox_id',
			toTable: 'email_inboxes',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'SET NULL',
			match: noMatch,
		},
		{
			from: 'message_id',
			toTable: 'system_email_messages',
			to: 'id',
			onUpdate: noAction,
			onDelete: 'SET NULL',
			match: noMatch,
		},
	])

	assertTableChecks(db, 'system_email_messages', [
		{
			label: 'direction enum',
			sql: "CHECK (direction IN ('inbound', 'outbound'))",
		},
		{
			label: 'processing_status enum',
			sql: "CHECK (processing_status IN ('stored', 'sent', 'failed'))",
		},
		{
			label: 'classification enum',
			sql: "CHECK (classification IN ('accepted', 'quarantined'))",
		},
	])
	assertTableChecks(db, 'system_email_attachments', [
		{
			label: 'storage_kind enum',
			sql: "CHECK (storage_kind IN ('raw-mime', 'external', 'unavailable'))",
		},
	])
	assertTableChecks(db, 'system_email_delivery_events', [
		{
			label: 'event_type enum',
			sql: `CHECK (
				event_type IN (
					'receive_started', 'received', 'rejected', 'send_requested', 'sent',
					'failed', 'delivered', 'deferred', 'bounced', 'complained'
				)
			)`,
		},
		{
			label: 'needs_effect_reconcile boolean',
			sql: 'CHECK (needs_effect_reconcile IN (0, 1))',
		},
		{
			label: 'state enum',
			sql: `CHECK (
				state IS NULL
				OR state IN (
					'pending', 'storing', 'cleaning', 'received', 'rejected',
					'orphan-cleaned'
				)
			)`,
		},
		{
			label: 'subscription_effect_state enum',
			sql: `CHECK (
				subscription_effect_state IS NULL
				OR subscription_effect_state IN (
					'pending', 'processing', 'complete', 'dead-letter'
				)
			)`,
		},
	])
})

test('0131 replaces dedicated drift with legacy authority before cutover', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailAuthorityMigration)
	db.exec(`
		INSERT INTO system_email_messages (
			id, direction, from_address, processing_status, created_at, updated_at
		) VALUES (
			'dedicated-kept', 'inbound', 'sender@example.net', 'stored',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		);
		INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			created_at, updated_at
		) VALUES (
			'legacy-kept', 'inbound', 'system:email', 'sender@example.net',
			'stored', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		);
	`)
	const jsonOnlyDelivery = {
		fingerprint: 'json-only-fingerprint',
		deliveryId: 'json-only-delivery',
		messageId: 'json-only-message',
		threadId: 'json-only-thread',
		rawMimeKey: 'email-raw:v1:system:email/json-only-message',
		userId: 'system:email',
		inboxId: 'json-only-inbox',
		recipient: 'support@example.com',
		envelopeFrom: 'sender@example.net',
		provider: 'cloudflare-email-routing',
		quotaDay: '2026-08-02',
		dedupeExpiresAt: '2026-08-04T00:00:00.000Z',
		state: 'received',
		storageLease: 'storage-lease',
		storageLeaseAt: '2026-08-02T00:01:00.000Z',
		cleanupLease: 'cleanup-lease',
		cleanupLeaseAt: '2026-08-02T00:02:00.000Z',
		cleanupRetryAt: '2026-08-02T00:03:00.000Z',
		expectedAttachmentCount: 2,
		finalizationToken: 'finalization-token',
		reconcileAfter: '2026-08-02T00:04:00.000Z',
		usageEffectRecordedAt: '2026-08-02T00:04:30.000Z',
		usageEffectSuppressedAt: '2026-08-02T00:05:00.000Z',
		usageStartedAt: '2026-08-02T00:06:00.000Z',
		usageDurationMs: 321,
		usageMonth: '2026-08',
		usageBytes: 654,
		usageEffectRetryAt: '2026-08-02T00:07:00.000Z',
		usageEffectLease: 'usage-lease',
		usageEffectLeaseAt: '2026-08-02T00:08:00.000Z',
		subscriptionEffectState: 'processing',
		subscriptionEffectLease: 'subscription-lease',
		subscriptionEffectLeaseAt: '2026-08-02T00:09:00.000Z',
		subscriptionEffectRetryAt: '2026-08-02T00:10:00.000Z',
		subscriptionEffectAttemptCount: 2,
		subscriptionEffectDeadLetterAt: '2026-08-02T00:11:00.000Z',
		subscriptionEffectLastError: 'retry me',
	}
	db.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, event_type, provider, detail_json, created_at
		) VALUES (?, 'system:email', 'received', 'cloudflare-email-routing', ?, ?)`,
	).run(
		jsonOnlyDelivery.deliveryId,
		JSON.stringify(jsonOnlyDelivery),
		'2026-08-02T00:00:00.000Z',
	)

	applyMigrationLikeD1(db, systemEmailAuthorityMigration)

	expect(
		db
			.prepare(
				`SELECT singleton, authority, graph_mismatch_count,
					provider_link_count
				FROM system_email_graph_authority`,
			)
			.get(),
	).toEqual({
		singleton: 1,
		authority: 'dedicated',
		graph_mismatch_count: 0,
		provider_link_count: 0,
	})
	expect(
		db
			.prepare(
				`SELECT state, fingerprint, storage_lease, storage_lease_at,
					cleanup_lease, cleanup_lease_at, cleanup_retry_at,
					expected_attachment_count, finalization_token, reconcile_after,
					dedupe_expires_at, usage_effect_recorded_at,
					usage_effect_suppressed_at, usage_started_at,
					usage_duration_ms, usage_month, usage_bytes, usage_effect_retry_at,
					usage_effect_lease, usage_effect_lease_at,
					subscription_effect_state, subscription_effect_lease,
					subscription_effect_lease_at, subscription_effect_retry_at,
					subscription_effect_attempt_count,
					subscription_effect_dead_letter_at,
					subscription_effect_last_error, updated_at
				FROM system_email_delivery_events
				WHERE id = ?`,
			)
			.get(jsonOnlyDelivery.deliveryId),
	).toEqual({
		state: 'received',
		fingerprint: jsonOnlyDelivery.fingerprint,
		storage_lease: jsonOnlyDelivery.storageLease,
		storage_lease_at: jsonOnlyDelivery.storageLeaseAt,
		cleanup_lease: jsonOnlyDelivery.cleanupLease,
		cleanup_lease_at: jsonOnlyDelivery.cleanupLeaseAt,
		cleanup_retry_at: jsonOnlyDelivery.cleanupRetryAt,
		expected_attachment_count: jsonOnlyDelivery.expectedAttachmentCount,
		finalization_token: jsonOnlyDelivery.finalizationToken,
		reconcile_after: jsonOnlyDelivery.reconcileAfter,
		dedupe_expires_at: jsonOnlyDelivery.dedupeExpiresAt,
		usage_effect_recorded_at: jsonOnlyDelivery.usageEffectRecordedAt,
		usage_effect_suppressed_at: jsonOnlyDelivery.usageEffectSuppressedAt,
		usage_started_at: jsonOnlyDelivery.usageStartedAt,
		usage_duration_ms: jsonOnlyDelivery.usageDurationMs,
		usage_month: jsonOnlyDelivery.usageMonth,
		usage_bytes: jsonOnlyDelivery.usageBytes,
		usage_effect_retry_at: jsonOnlyDelivery.usageEffectRetryAt,
		usage_effect_lease: jsonOnlyDelivery.usageEffectLease,
		usage_effect_lease_at: jsonOnlyDelivery.usageEffectLeaseAt,
		subscription_effect_state: jsonOnlyDelivery.subscriptionEffectState,
		subscription_effect_lease: jsonOnlyDelivery.subscriptionEffectLease,
		subscription_effect_lease_at: jsonOnlyDelivery.subscriptionEffectLeaseAt,
		subscription_effect_retry_at: jsonOnlyDelivery.subscriptionEffectRetryAt,
		subscription_effect_attempt_count:
			jsonOnlyDelivery.subscriptionEffectAttemptCount,
		subscription_effect_dead_letter_at:
			jsonOnlyDelivery.subscriptionEffectDeadLetterAt,
		subscription_effect_last_error:
			jsonOnlyDelivery.subscriptionEffectLastError,
		updated_at: '2026-08-02T00:00:00.000Z',
	})
	expect(
		db
			.prepare(
				`SELECT
				(SELECT COUNT(*) FROM system_email_messages) AS dedicated,
				(SELECT COUNT(*) FROM email_messages WHERE user_id = 'system:email')
					AS legacy`,
			)
			.get(),
	).toEqual({ dedicated: 1, legacy: 1 })
})

test('0131 replaces stale 0129 inbound columns with the exact JSON transition projection', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailGraphMigration)
	const createdAt = '2026-08-02T00:00:00.000Z'
	const insert = db.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, event_type, provider, detail_json, created_at,
			needs_effect_reconcile
		) VALUES (?, 'system:email', ?, ?, ?, ?, ?)`,
	)
	insert.run(
		'stale-storing',
		'receive_started',
		'cloudflare-email-routing',
		JSON.stringify({
			state: 'storing',
			fingerprint: 'new-fingerprint',
			storageLease: 'new-storage-lease',
			storageLeaseAt: '2026-08-03T00:01:00.000Z',
			expectedAttachmentCount: 2,
			usageStartedAt: '2026-08-03T00:00:00.000Z',
			subscriptionEffectState: 'pending',
		}),
		createdAt,
		1,
	)
	insert.run(
		'received-complete',
		'received',
		'cloudflare-email-routing',
		JSON.stringify({
			state: 'received',
			fingerprint: 'received-fingerprint',
			finalizationToken: 'new-finalization',
			usageEffectRecordedAt: '2026-08-03T00:05:00.000Z',
			usageMonth: '2026-08',
			usageBytes: 321,
			usageDurationMs: 654,
			subscriptionEffectState: 'complete',
			subscriptionEffectAttemptCount: 3,
		}),
		createdAt,
		0,
	)
	insert.run(
		'stale-dedupe',
		'receive_started',
		'cloudflare-email-routing-dedupe',
		JSON.stringify({
			state: 'pending',
			fingerprint: 'new-dedupe-fingerprint',
			dedupeExpiresAt: '2026-08-05T00:00:00.000Z',
		}),
		createdAt,
		1,
	)
	insert.run(
		'non-inbound-preserved',
		'sent',
		'kody',
		JSON.stringify({
			state: 'storing',
			storageLease: 'json-must-not-win',
		}),
		createdAt,
		0,
	)
	db.exec(`
		UPDATE email_delivery_events
		SET
			usage_effect_recorded_at = 'old-usage-recorded',
			usage_month = '2025-01',
			usage_bytes = 999,
			usage_duration_ms = 999,
			state = 'pending',
			fingerprint = 'old-fingerprint',
			storage_lease = 'old-storage-lease',
			storage_lease_at = '2026-08-01T00:00:00.000Z',
			cleanup_lease = 'old-cleanup-lease',
			cleanup_lease_at = '2026-08-01T00:01:00.000Z',
			cleanup_retry_at = '2026-08-01T00:02:00.000Z',
			expected_attachment_count = 99,
			finalization_token = 'old-finalization',
			reconcile_after = '2026-08-01T00:03:00.000Z',
			dedupe_expires_at = '2026-08-01T00:04:00.000Z',
			usage_effect_suppressed_at = '2026-08-01T00:05:00.000Z',
			usage_started_at = '2026-08-01T00:06:00.000Z',
			usage_effect_retry_at = '2026-08-01T00:07:00.000Z',
			usage_effect_lease = 'old-usage-lease',
			usage_effect_lease_at = '2026-08-01T00:08:00.000Z',
			subscription_effect_state = 'processing',
			subscription_effect_lease = 'old-subscription-lease',
			subscription_effect_lease_at = '2026-08-01T00:09:00.000Z',
			subscription_effect_retry_at = '2026-08-01T00:10:00.000Z',
			subscription_effect_attempt_count = 99,
			subscription_effect_dead_letter_at = '2026-08-01T00:11:00.000Z',
			subscription_effect_last_error = 'old error',
			updated_at = '2026-08-01T00:12:00.000Z';
	`)

	applyMigrationLikeD1(db, systemEmailGraphMigration)
	applyMigrationLikeD1(db, systemEmailAuthorityMigration)

	const selectProjection = db.prepare(
		`SELECT
			needs_effect_reconcile, usage_effect_recorded_at, usage_month,
			usage_bytes, usage_duration_ms, state, fingerprint, storage_lease,
			storage_lease_at, cleanup_lease, cleanup_lease_at, cleanup_retry_at,
			expected_attachment_count, finalization_token, reconcile_after,
			dedupe_expires_at, usage_effect_suppressed_at, usage_started_at,
			usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
			subscription_effect_state, subscription_effect_lease,
			subscription_effect_lease_at, subscription_effect_retry_at,
			subscription_effect_attempt_count, subscription_effect_dead_letter_at,
			subscription_effect_last_error, updated_at
		FROM system_email_delivery_events
		WHERE id = ?`,
	)
	expect(selectProjection.get('stale-storing')).toEqual({
		needs_effect_reconcile: 1,
		usage_effect_recorded_at: null,
		usage_month: null,
		usage_bytes: null,
		usage_duration_ms: null,
		state: 'storing',
		fingerprint: 'new-fingerprint',
		storage_lease: 'new-storage-lease',
		storage_lease_at: '2026-08-03T00:01:00.000Z',
		cleanup_lease: null,
		cleanup_lease_at: null,
		cleanup_retry_at: null,
		expected_attachment_count: 2,
		finalization_token: null,
		reconcile_after: null,
		dedupe_expires_at: null,
		usage_effect_suppressed_at: null,
		usage_started_at: '2026-08-03T00:00:00.000Z',
		usage_effect_retry_at: null,
		usage_effect_lease: null,
		usage_effect_lease_at: null,
		subscription_effect_state: 'pending',
		subscription_effect_lease: null,
		subscription_effect_lease_at: null,
		subscription_effect_retry_at: null,
		subscription_effect_attempt_count: null,
		subscription_effect_dead_letter_at: null,
		subscription_effect_last_error: null,
		updated_at: createdAt,
	})
	expect(selectProjection.get('received-complete')).toMatchObject({
		needs_effect_reconcile: 0,
		usage_effect_recorded_at: '2026-08-03T00:05:00.000Z',
		usage_month: '2026-08',
		usage_bytes: 321,
		usage_duration_ms: 654,
		state: 'received',
		fingerprint: 'received-fingerprint',
		storage_lease: null,
		cleanup_lease: null,
		finalization_token: 'new-finalization',
		usage_effect_lease: null,
		subscription_effect_state: 'complete',
		subscription_effect_lease: null,
		subscription_effect_attempt_count: 3,
	})
	expect(selectProjection.get('stale-dedupe')).toMatchObject({
		state: 'pending',
		fingerprint: 'new-dedupe-fingerprint',
		storage_lease: null,
		dedupe_expires_at: '2026-08-05T00:00:00.000Z',
		usage_effect_lease: null,
		subscription_effect_lease: null,
	})
	expect(selectProjection.get('non-inbound-preserved')).toMatchObject({
		needs_effect_reconcile: 0,
		usage_effect_recorded_at: 'old-usage-recorded',
		state: 'pending',
		fingerprint: 'old-fingerprint',
		storage_lease: 'old-storage-lease',
		cleanup_lease: 'old-cleanup-lease',
		finalization_token: 'old-finalization',
		usage_effect_lease: 'old-usage-lease',
		subscription_effect_lease: 'old-subscription-lease',
		updated_at: '2026-08-01T00:12:00.000Z',
	})
	expect(
		db
			.prepare(
				`SELECT graph_mismatch_count
				FROM system_email_graph_authority`,
			)
			.get(),
	).toEqual({ graph_mismatch_count: 0 })
})

test('0131 catches up create, update, and delete drift across all four graph tables', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailGraphMigration)
	const createdAt = '2026-08-02T00:00:00.000Z'
	db.exec(`
		INSERT INTO email_threads (
			id, user_id, subject_normalized, last_message_at, created_at, updated_at
		) VALUES
			('thread-kept', 'system:email', 'before', '${createdAt}',
				'${createdAt}', '${createdAt}'),
			('thread-deleted', 'system:email', 'delete', '${createdAt}',
				'${createdAt}', '${createdAt}');
		INSERT INTO email_messages (
			id, direction, user_id, thread_id, from_address, subject,
			processing_status, created_at, updated_at
		) VALUES
			('message-kept', 'inbound', 'system:email', 'thread-kept',
				'sender@example.net', 'before', 'stored', '${createdAt}', '${createdAt}'),
			('message-deleted', 'inbound', 'system:email', 'thread-deleted',
				'sender@example.net', 'delete', 'stored', '${createdAt}', '${createdAt}');
		INSERT INTO email_attachments (
			id, message_id, filename, content_type, size, storage_kind, created_at
		) VALUES
			('attachment-kept', 'message-kept', 'before.txt', 'text/plain', 1,
				'raw-mime', '${createdAt}'),
			('attachment-deleted', 'message-deleted', 'delete.txt', 'text/plain', 2,
				'raw-mime', '${createdAt}');
		INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, provider, detail_json, created_at,
			state, updated_at
		) VALUES
			('event-kept', 'message-kept', 'system:email', 'received', 'test', '{}',
				'${createdAt}', 'received', '${createdAt}'),
			('event-deleted', 'message-deleted', 'system:email', 'received', 'test',
				'{}', '${createdAt}', 'received', '${createdAt}');
	`)
	applyMigrationLikeD1(db, systemEmailGraphMigration)

	const updatedAt = '2026-08-03T00:00:00.000Z'
	db.exec(`
		UPDATE email_threads
		SET subject_normalized = 'after', updated_at = '${updatedAt}'
		WHERE id = 'thread-kept';
		UPDATE email_messages
		SET subject = 'after', updated_at = '${updatedAt}'
		WHERE id = 'message-kept';
		UPDATE email_attachments
		SET filename = 'after.txt'
		WHERE id = 'attachment-kept';
		UPDATE email_delivery_events
		SET detail_json = '{"caughtUp":true}', updated_at = '${updatedAt}'
		WHERE id = 'event-kept';

		DELETE FROM email_delivery_events WHERE id = 'event-deleted';
		DELETE FROM email_attachments WHERE id = 'attachment-deleted';
		DELETE FROM email_messages WHERE id = 'message-deleted';
		DELETE FROM email_threads WHERE id = 'thread-deleted';

		INSERT INTO email_threads (
			id, user_id, subject_normalized, last_message_at, created_at, updated_at
		) VALUES (
			'thread-created', 'system:email', 'created', '${updatedAt}',
			'${updatedAt}', '${updatedAt}'
		);
		INSERT INTO email_messages (
			id, direction, user_id, thread_id, from_address, subject,
			processing_status, created_at, updated_at
		) VALUES (
			'message-created', 'inbound', 'system:email', 'thread-created',
			'new@example.net', 'created', 'stored', '${updatedAt}', '${updatedAt}'
		);
		INSERT INTO email_attachments (
			id, message_id, filename, content_type, size, storage_kind, created_at
		) VALUES (
			'attachment-created', 'message-created', 'created.txt', 'text/plain', 3,
			'raw-mime', '${updatedAt}'
		);
		INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, provider, detail_json, created_at,
			state, updated_at
		) VALUES (
			'event-created', 'message-created', 'system:email', 'received', 'test',
			'{}', '${updatedAt}', 'received', '${updatedAt}'
		);
	`)

	applyMigrationLikeD1(db, systemEmailAuthorityMigration)

	for (const contract of systemEmailGraphColumnContracts) {
		expect(
			graphParityDifferenceCount(db, contract),
			`${contract.key} differs after legacy catch-up`,
		).toBe(0)
	}
	expect(
		db
			.prepare(
				`SELECT graph_mismatch_count
				FROM system_email_graph_authority
				WHERE singleton = 1`,
			)
			.get(),
	).toEqual({ graph_mismatch_count: 0 })
})

test('0131 aborts cutover when a system provider link exists', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailAuthorityMigration)
	db.exec(`
		INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			provider_message_id, created_at, updated_at
		) VALUES (
			'provider-linked-system', 'outbound', 'system:email',
			'support@example.com', 'sent', 'provider-message-1',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		);
		INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, created_at,
			updated_at
		) VALUES (
			'resend', 'provider-message-1', 'system:email',
			'provider-linked-system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		);
	`)

	expect(() =>
		applyMigrationLikeD1(db, systemEmailAuthorityMigration),
	).toThrow()
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'system_email_graph_authority'`,
			)
			.get(),
	).toBeUndefined()
})

test('0131 rolls back catch-up and leaves no marker for invalid cross-owner references', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailAuthorityMigration)
	db.exec(`
		INSERT INTO email_inboxes (
			id, user_id, name, enabled, created_at, updated_at
		) VALUES (
			'user-inbox', 'user-1', 'private', 1, CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP
		);
		INSERT INTO email_threads (
			id, user_id, inbox_id, subject_normalized, last_message_at,
			created_at, updated_at
		) VALUES
			(
				'valid-new-thread', 'system:email', NULL, 'valid', CURRENT_TIMESTAMP,
				CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			),
			(
				'invalid-cross-owner-thread', 'system:email', 'user-inbox',
				'invalid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			);
		CREATE TRIGGER fail_if_graph_mutation_reached
		BEFORE INSERT ON system_email_threads
		BEGIN
			SELECT RAISE(ABORT, 'graph mutation reached');
		END;
	`)

	expect(() => applyMigrationLikeD1(db, systemEmailAuthorityMigration)).toThrow(
		/CHECK constraint failed/u,
	)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'system_email_graph_authority'`,
			)
			.get(),
	).toBeUndefined()
	expect(
		db
			.prepare(
				`SELECT id FROM system_email_threads
				WHERE id = 'valid-new-thread'`,
			)
			.get(),
	).toBeUndefined()
})

test('0131 mismatch gate rolls back when a valid legacy row cannot be copied', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailGraphMigration)
	db.exec(`
		INSERT INTO email_threads (
			id, user_id, subject_normalized, last_message_at, created_at, updated_at
		) VALUES (
			'forced-mismatch', 'system:email', 'before', CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		);
	`)
	applyMigrationLikeD1(db, systemEmailGraphMigration)
	db.exec(`
		UPDATE email_threads
		SET subject_normalized = 'after'
		WHERE id = 'forced-mismatch';
		CREATE TRIGGER force_system_thread_copy_mismatch
		BEFORE UPDATE ON system_email_threads
		WHEN NEW.id = 'forced-mismatch'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`)

	expect(() =>
		applyMigrationLikeD1(db, systemEmailAuthorityMigration),
	).toThrow()
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'system_email_graph_authority'`,
			)
			.get(),
	).toBeUndefined()
	expect(
		db
			.prepare(
				`SELECT subject_normalized
				FROM system_email_threads
				WHERE id = 'forced-mismatch'`,
			)
			.get(),
	).toEqual({ subject_normalized: 'before' })
})

test('0131 promotes JSON-only stale, dedupe, and effect rows into live processing', async () => {
	using sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, systemEmailGraphMigration)
	const now = new Date('2026-08-03T00:00:00.000Z')
	const createdAt = '2026-07-30T00:00:00.000Z'
	const base = {
		fingerprint: 'json-only-fingerprint',
		messageId: 'json-only-message',
		threadId: 'json-only-thread',
		rawMimeKey: 'email-raw:v1:system:email/json-only-message',
		userId: 'system:email',
		inboxId: 'json-only-inbox',
		recipient: 'support@example.com',
		envelopeFrom: 'sender@example.net',
		provider: 'cloudflare-email-routing',
		quotaDay: '2026-07-30',
	}
	const rows = [
		{
			id: 'json-only-stale',
			provider: 'cloudflare-email-routing',
			eventType: 'receive_started',
			detail: {
				...base,
				deliveryId: 'json-only-stale',
				state: 'pending',
				dedupeExpiresAt: '2026-08-05T00:00:00.000Z',
				reconcileAfter: '2026-08-02T00:00:00.000Z',
			},
		},
		{
			id: 'email-inbound-dedupe:json-only-fingerprint',
			provider: 'cloudflare-email-routing-dedupe',
			eventType: 'receive_started',
			detail: {
				...base,
				deliveryId: 'json-only-dedupe-delivery',
				state: 'pending',
				dedupeExpiresAt: '2026-08-02T00:00:00.000Z',
			},
		},
		{
			id: 'json-only-effect',
			provider: 'cloudflare-email-routing',
			eventType: 'received',
			detail: {
				...base,
				deliveryId: 'json-only-effect',
				state: 'received',
				dedupeExpiresAt: '2026-08-05T00:00:00.000Z',
				finalizationToken: 'json-only-finalization',
				usageEffectRecordedAt: '2026-08-02T00:00:00.000Z',
				subscriptionEffectState: 'pending',
			},
		},
	]
	const insert = sqlite.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, event_type, provider, provider_event_id, detail_json,
			created_at
		) VALUES (?, 'system:email', ?, ?, ?, ?, ?)`,
	)
	for (const row of rows) {
		insert.run(
			row.id,
			row.eventType,
			row.provider,
			row.id,
			JSON.stringify(row.detail),
			createdAt,
		)
	}

	applyMigrationLikeD1(sqlite, systemEmailGraphMigration)
	applyMigrationLikeD1(sqlite, systemEmailAuthorityMigration)
	const db = createD1FromSqlite(sqlite)

	expect(await listDueSystemInboundEffects({ db, now, limit: 10 })).toEqual([
		{ id: 'json-only-effect' },
	])
	const effectLease = await claimSystemInboundSubscriptionEffect({
		db,
		deliveryId: 'json-only-effect',
		finalizationToken: 'json-only-finalization',
		now,
	})
	expect(effectLease).toEqual(expect.any(String))
	expect(
		await completeSystemInboundSubscriptionEffect({
			db,
			deliveryId: 'json-only-effect',
			lease: effectLease!,
			now,
		}),
	).toBe(true)

	expect(
		await pruneSystemExpiredInboundDedupePointers({ db, now, limit: 10 }),
	).toBe(1)
	expect(
		sqlite
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM system_email_delivery_events
						WHERE id = 'email-inbound-dedupe:json-only-fingerprint')
						AS dedicated,
					(SELECT COUNT(*) FROM email_delivery_events
						WHERE id = 'email-inbound-dedupe:json-only-fingerprint')
						AS legacy`,
			)
			.get(),
	).toEqual({ dedicated: 0, legacy: 0 })

	expect(
		await reconcileSystemStaleInboundDeliveries({
			db,
			blobs: {
				delete: async () => undefined,
			} as R2Bucket,
			now,
		}),
	).toMatchObject({ cleaned: 1, recovered: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT dedicated.state, legacy.state AS legacy_state
				FROM system_email_delivery_events dedicated
				INNER JOIN email_delivery_events legacy ON legacy.id = dedicated.id
				WHERE dedicated.id = 'json-only-stale'`,
			)
			.get(),
	).toEqual({ state: 'orphan-cleaned', legacy_state: 'orphan-cleaned' })
})

test('0130 copies only the system graph with promoted fields and preserves legacy rows', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, systemEmailGraphMigration)
	db.exec('PRAGMA foreign_keys = ON')

	const createdAt = '2026-08-02T20:00:00.000Z'
	const updatedAt = '2026-08-02T20:05:00.000Z'
	db.exec(`
		INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES
			('system-inbox', 'system:email', 'support', 'Operator inbox', 1,
				'${createdAt}', '${updatedAt}'),
			('user-inbox', 'user-1', 'personal', 'User inbox', 1,
				'${createdAt}', '${updatedAt}');

		INSERT INTO email_sender_identities (
			id, user_id, email, display_name, status, verified_at,
			created_at, updated_at
		) VALUES
			(
				'system-sender', 'system:email', 'support@example.com', 'Support',
				'verified', '${createdAt}', '${createdAt}', '${updatedAt}'
			),
			(
				'user-sender', 'user-1', 'user@example.com', 'User',
				'verified', '${createdAt}', '${createdAt}', '${updatedAt}'
			);

		INSERT INTO email_threads (
			id, user_id, inbox_id, subject_normalized, root_message_id_header,
			last_message_at, created_at, updated_at
		) VALUES
			('system-thread', 'system:email', 'system-inbox', 'incident',
				'<system-root@example.com>', '${updatedAt}', '${createdAt}', '${updatedAt}'),
			('cross-owner-thread', 'system:email', 'user-inbox', 'cross owner',
				NULL, '${updatedAt}', '${createdAt}', '${updatedAt}'),
			('user-thread', 'user-1', 'user-inbox', 'private',
				'<user-root@example.com>', '${updatedAt}', '${createdAt}', '${updatedAt}');

		INSERT INTO email_messages (
			id, direction, user_id, inbox_id, thread_id, sender_identity_id,
			from_address, envelope_from, to_addresses_json, cc_addresses_json,
			bcc_addresses_json, reply_to_addresses_json, subject,
			message_id_header, in_reply_to_header, references_json, headers_json,
			auth_results, text_body, html_body, raw_size, processing_status,
			provider_message_id, error, received_at, sent_at, created_at,
			updated_at, raw_mime_key, delivery_status, delivery_status_at,
			classification, classification_reason
		) VALUES
			(
				'system-inbound', 'inbound', 'system:email', 'system-inbox',
				'system-thread', NULL, 'sender@example.net', 'bounce@example.net',
				'["support@example.com"]', '[]', '[]', '[]', 'Incident',
				'<system-inbound@example.net>', NULL, '[]', '{"x-test":"system"}',
				'dkim=pass', 'operator body', '<p>operator body</p>', 512, 'stored',
				NULL, NULL, '${createdAt}', NULL, '${createdAt}', '${updatedAt}',
				'email-raw:v1:system:email/system-inbound', NULL, NULL,
				'quarantined', 'sender-rule'
			),
			(
				'system-outbound', 'outbound', 'system:email', 'system-inbox',
				'system-thread', 'system-sender', 'support@example.com', NULL,
				'["recipient@example.net"]', '[]', '[]', '[]', 'Reply',
				'<system-outbound@example.com>', '<system-inbound@example.net>',
				'["<system-inbound@example.net>"]', '{}', NULL, 'reply body', NULL,
				128, 'sent', 'provider-system-1', NULL, NULL, '${updatedAt}',
				'${updatedAt}', '${updatedAt}', NULL, 'delivered', '${updatedAt}',
				'accepted', NULL
			),
			(
				'user-message', 'inbound', 'user-1', 'user-inbox', 'user-thread',
				NULL, 'private@example.net', NULL, '["user@example.com"]', '[]',
				'[]', '[]', 'Private', '<user-message@example.net>', NULL, '[]',
				'{}', NULL, 'private body', NULL, 64, 'stored', NULL, NULL,
				'${createdAt}', NULL, '${createdAt}', '${updatedAt}', NULL, NULL,
				NULL, 'accepted', NULL
			),
			(
				'cross-owner-message', 'outbound', 'system:email', 'user-inbox',
				'user-thread', 'user-sender', 'support@example.com', NULL,
				'["recipient@example.net"]', '[]', '[]', '[]', 'Cross owner',
				'<cross-owner@example.com>', NULL, '[]', '{}', NULL, 'body', NULL,
				32, 'sent', 'provider-cross-owner', NULL, NULL, '${updatedAt}',
				'${createdAt}', '${updatedAt}', NULL, NULL, NULL, 'accepted', NULL
			);

		INSERT INTO email_attachments (
			id, message_id, filename, content_type, content_id, disposition, size,
			storage_kind, storage_key, created_at
		) VALUES
			('system-attachment', 'system-inbound', 'evidence.txt', 'text/plain',
				'<attachment-1>', 'attachment', 42, 'external',
				'email-attachment:v1:system:email/system-inbound/system-attachment',
				'${createdAt}'),
			('user-attachment', 'user-message', 'private.txt', 'text/plain', NULL,
				'attachment', 7, 'raw-mime', NULL, '${createdAt}'),
			('cross-owner-attachment', 'cross-owner-message', 'cross.txt',
				'text/plain', NULL, 'attachment', 2, 'raw-mime', NULL,
				'${createdAt}');

		INSERT INTO email_delivery_events (
			id, message_id, user_id, inbox_id, event_type, provider,
			provider_message_id, provider_event_id, detail_json, created_at,
			needs_effect_reconcile, usage_effect_recorded_at, usage_month,
			usage_bytes, usage_duration_ms, state, fingerprint, storage_lease,
			storage_lease_at, cleanup_lease, cleanup_lease_at, cleanup_retry_at,
			expected_attachment_count, finalization_token, reconcile_after,
			dedupe_expires_at, usage_effect_suppressed_at, usage_started_at,
			usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
			subscription_effect_state, subscription_effect_lease,
			subscription_effect_lease_at, subscription_effect_retry_at,
			subscription_effect_attempt_count, subscription_effect_dead_letter_at,
			subscription_effect_last_error, updated_at
		) VALUES
			(
				'system-delivery', 'system-inbound', 'system:email', 'system-inbox',
				'received', 'cloudflare-email-routing', NULL, 'provider-event-1',
				'{"state":"received","fingerprint":"fingerprint-1"}', '${createdAt}',
				1, NULL, '2026-08', 512, 321, 'received', 'fingerprint-1',
				'storage-lease', '${createdAt}', 'cleanup-lease', '${createdAt}',
				NULL, 1, 'finalization-1', '${updatedAt}', NULL, NULL, '${createdAt}',
				'${updatedAt}', 'usage-lease', '${createdAt}', 'processing',
				'subscription-lease', '${createdAt}', '${updatedAt}', 2, NULL,
				'temporary failure', '${updatedAt}'
			),
			(
				'user-delivery', 'user-message', 'user-1', 'user-inbox', 'received',
				'cloudflare-email-routing', NULL, 'provider-event-user', '{}',
				'${createdAt}', 0, '${updatedAt}', '2026-08', 64, 10, 'received',
				'user-fingerprint', NULL, NULL, NULL, NULL, NULL, 0,
				'user-finalization', NULL, NULL, NULL, '${createdAt}', NULL, NULL,
				NULL, 'complete', NULL, NULL, NULL, 1, NULL, NULL, '${updatedAt}'
			),
			(
				'cross-owner-delivery', 'cross-owner-message', 'system:email',
				'user-inbox', 'sent', 'kody', 'provider-cross-owner', NULL, '{}',
				'${createdAt}', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '${updatedAt}'
			);

		INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, inbox_id,
			created_at, updated_at
		) VALUES (
			'cloudflare-email', 'provider-system-1', 'system:email',
			'system-outbound', 'system-inbox', '${createdAt}', '${updatedAt}'
		);
	`)

	applyMigrationLikeD1(db, systemEmailGraphMigration)
	applyMigrationLikeD1(db, systemEmailGraphMigration)

	expect(
		db
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM system_email_threads) AS threads,
					(SELECT COUNT(*) FROM system_email_messages) AS messages,
					(SELECT COUNT(*) FROM system_email_attachments) AS attachments,
					(SELECT COUNT(*) FROM system_email_delivery_events) AS events`,
			)
			.get(),
	).toEqual({ threads: 1, messages: 2, attachments: 1, events: 1 })
	expect(
		db
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM email_threads) AS threads,
					(SELECT COUNT(*) FROM email_messages) AS messages,
					(SELECT COUNT(*) FROM email_attachments) AS attachments,
					(SELECT COUNT(*) FROM email_delivery_events) AS events`,
			)
			.get(),
	).toEqual({ threads: 3, messages: 4, attachments: 3, events: 3 })

	expect(
		db
			.prepare(
				`SELECT
					state, fingerprint, expected_attachment_count,
					finalization_token, usage_month, usage_bytes, usage_duration_ms,
					usage_effect_lease, subscription_effect_state,
					subscription_effect_attempt_count, subscription_effect_last_error,
					updated_at
				FROM system_email_delivery_events
				WHERE id = 'system-delivery'`,
			)
			.get(),
	).toEqual({
		state: 'received',
		fingerprint: 'fingerprint-1',
		expected_attachment_count: 1,
		finalization_token: 'finalization-1',
		usage_month: '2026-08',
		usage_bytes: 512,
		usage_duration_ms: 321,
		usage_effect_lease: 'usage-lease',
		subscription_effect_state: 'processing',
		subscription_effect_attempt_count: 2,
		subscription_effect_last_error: 'temporary failure',
		updated_at: updatedAt,
	})
	expect(
		db
			.prepare(
				`SELECT thread_id, raw_mime_key, classification, classification_reason
				FROM system_email_messages
				WHERE id = 'system-inbound'`,
			)
			.get(),
	).toEqual({
		thread_id: 'system-thread',
		raw_mime_key: 'email-raw:v1:system:email/system-inbound',
		classification: 'quarantined',
		classification_reason: 'sender-rule',
	})
	expect(
		db
			.prepare(
				`SELECT message_id, storage_kind, storage_key
				FROM system_email_attachments`,
			)
			.get(),
	).toEqual({
		message_id: 'system-inbound',
		storage_kind: 'external',
		storage_key:
			'email-attachment:v1:system:email/system-inbound/system-attachment',
	})

	expect(
		systemEmailGraphColumnContracts
			.find((contract) => contract.key === 'deliveryEvents')
			?.columns.slice(-13),
	).toEqual([
		'usage_effect_suppressed_at',
		'usage_started_at',
		'usage_effect_retry_at',
		'usage_effect_lease',
		'usage_effect_lease_at',
		'subscription_effect_state',
		'subscription_effect_lease',
		'subscription_effect_lease_at',
		'subscription_effect_retry_at',
		'subscription_effect_attempt_count',
		'subscription_effect_dead_letter_at',
		'subscription_effect_last_error',
		'updated_at',
	])
	expect(
		db
			.prepare(
				`SELECT id FROM system_email_threads
				WHERE id = 'cross-owner-thread'`,
			)
			.get(),
	).toBeUndefined()
	expect(
		db
			.prepare(
				`SELECT id FROM system_email_messages
				WHERE id = 'cross-owner-message'`,
			)
			.get(),
	).toBeUndefined()
	expect(
		db
			.prepare(
				`SELECT id FROM system_email_attachments
				WHERE id = 'cross-owner-attachment'`,
			)
			.get(),
	).toBeUndefined()
	expect(
		db
			.prepare(
				`SELECT id FROM system_email_delivery_events
				WHERE id = 'cross-owner-delivery'`,
			)
			.get(),
	).toBeUndefined()
	expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
	expect(
		db.prepare(`PRAGMA foreign_key_list(email_outbound_provider_index)`).all(),
	).toContainEqual(
		expect.objectContaining({
			table: 'email_messages',
			from: 'message_id',
			to: 'id',
		}),
	)
	expect(
		db
			.prepare(
				`SELECT name
				FROM sqlite_schema
				WHERE type = 'index' AND name LIKE 'idx_system_email_%'
				ORDER BY name`,
			)
			.all()
			.map((row) => row.name),
	).toEqual(
		expect.arrayContaining([
			'idx_system_email_threads_last_message_at',
			'idx_system_email_messages_provider_message_id',
			'idx_system_email_attachments_message_id',
			'idx_system_email_delivery_events_pending_effects',
			'idx_system_email_delivery_events_dedupe_expires',
		]),
	)
	expect(
		db
			.prepare(
				`SELECT user_id, message_id
				FROM email_outbound_provider_index
				WHERE provider_message_id = 'provider-system-1'`,
			)
			.get(),
	).toEqual({ user_id: 'system:email', message_id: 'system-outbound' })
})
