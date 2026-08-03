import { DatabaseSync } from 'node:sqlite'

import {
	mailboxPreDropApprovalColumns,
	mailboxPreDropApprovalContract,
	mailboxPreDropApprovalInsertSql,
	mailboxPreDropApprovalRow,
} from '@kody-internal/shared/mailbox-pre-drop-approval.ts'
import { expect, test } from 'vitest'

import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
} from '#worker/test-support/system-email-graph-migration.ts'

const approvalMigration = '0134-email-user-graph-drop-approval.sql'

function createDatabaseBeforeApproval() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	applyMigrationsBefore(sqlite, approvalMigration)
	return sqlite
}

function validInsert(overrides: Record<string, string | number> = {}): string {
	const values: Record<string, string | number> = {
		singleton: 1,
		request_id: '11111111-1111-4111-8111-111111111111',
		nonce: '0123456789abcdef0123456789abcdef',
		authority_frozen_at: '2026-08-03T12:00:00.000Z',
		authority_owner_count: 3,
		manifest_key:
			'adhoc/mailbox-drop/d1/22222222-2222-4222-8222-222222222222/20260803T120100000Z-0123456789abcdef0123456789abcdef-11111111-1111-4111-8111-111111111111/manifest.json',
		sql_object_key:
			'adhoc/mailbox-drop/d1/22222222-2222-4222-8222-222222222222/20260803T120100000Z-0123456789abcdef0123456789abcdef-11111111-1111-4111-8111-111111111111/backup-request.sql',
		sql_sha256: 'a'.repeat(64),
		sql_bytes: 123,
		r2_etag: 'b'.repeat(32),
		manifest_key_id: 'kody-dr-2026-07',
		manifest_signature_sha256: 'c'.repeat(64),
		verified_at: '2026-08-03T12:30:00.000Z',
		expires_at: '2026-08-03T14:30:00.000Z',
		owner_count: 2,
		thread_count: 3,
		message_count: 4,
		attachment_count: 5,
		event_count: 6,
		issued_by: 'backup-control-plane',
		source_account_id: '1'.repeat(32),
		source_database_id: '22222222-2222-4222-8222-222222222222',
		source_database_name: 'kody',
		export_bookmark: 'bookmark-1',
		export_scheduled_at: '2026-08-03T12:01:00.000Z',
		export_started_at: '2026-08-03T12:01:01.000Z',
		export_completed_at: '2026-08-03T12:29:00.000Z',
		build_commit: 'abcdef1234567',
		retention_tier: 'daily',
		restore_baseline_id: 'kody-migration-set-2026-08',
		restore_baseline_sha256: 'd'.repeat(64),
		signature_algorithm: 'Ed25519',
		...overrides,
	}
	const columns = Object.keys(values)
	const literals = Object.values(values).map((value) =>
		typeof value === 'number'
			? String(value)
			: `'${value.replaceAll("'", "''")}'`,
	)
	return `INSERT INTO email_user_graph_drop_approval (${columns.join(', ')})
		VALUES (${literals.join(', ')})`
}

function generatedProducerInsert(): string {
	return mailboxPreDropApprovalInsertSql(
		mailboxPreDropApprovalRow({
			requestId: '11111111-1111-4111-8111-111111111111',
			nonce: '0123456789abcdef0123456789abcdef',
			authorityFrozenAt: '2026-08-03T12:00:00.000Z',
			authorityOwnerCount: 3,
			manifestKey:
				'adhoc/mailbox-drop/d1/22222222-2222-4222-8222-222222222222/20260803T120100000Z-0123456789abcdef0123456789abcdef-11111111-1111-4111-8111-111111111111/manifest.json',
			sqlObjectKey:
				'adhoc/mailbox-drop/d1/22222222-2222-4222-8222-222222222222/20260803T120100000Z-0123456789abcdef0123456789abcdef-11111111-1111-4111-8111-111111111111/backup-request.sql',
			sqlSha256: 'a'.repeat(64),
			sqlBytes: 123,
			r2Etag: 'b'.repeat(32),
			manifestKeyId: 'kody-dr-2026-07',
			manifestSignatureSha256: 'c'.repeat(64),
			verifiedAt: '2026-08-03T12:30:00.000Z',
			expiresAt: '2026-08-03T14:30:00.000Z',
			ownerCount: 2,
			threadCount: 3,
			messageCount: 4,
			attachmentCount: 5,
			eventCount: 6,
			issuedBy: 'backup-control-plane',
			sourceAccountId: '1'.repeat(32),
			sourceDatabaseId: '22222222-2222-4222-8222-222222222222',
			sourceDatabaseName: 'kody',
			exportBookmark: 'bookmark-1',
			exportScheduledAt: '2026-08-03T12:01:00.000Z',
			exportStartedAt: '2026-08-03T12:01:01.000Z',
			exportCompletedAt: '2026-08-03T12:29:00.000Z',
			buildCommit: 'abcdef1234567',
			retentionTier: 'daily',
			restoreBaselineId: 'kody-migration-set-2026-08',
			restoreBaselineSha256: 'd'.repeat(64),
			signatureAlgorithm: 'Ed25519',
		}),
	)
}

test('0134 is non-destructive and creates only the constrained approval table', () => {
	using sqlite = createDatabaseBeforeApproval()
	const before = new Set(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_schema
				WHERE name NOT LIKE 'sqlite_%'`,
			)
			.all()
			.map((row) => String(row.name)),
	)
	applyMigrationLikeD1(sqlite, approvalMigration)
	const additions = sqlite
		.prepare(
			`SELECT name FROM sqlite_schema
			WHERE name NOT LIKE 'sqlite_%'`,
		)
		.all()
		.map((row) => String(row.name))
		.filter((name) => !before.has(name))
	expect(additions).toEqual(['email_user_graph_drop_approval'])

	const schema = sqlite
		.prepare(`PRAGMA table_info(email_user_graph_drop_approval)`)
		.all()
	expect(schema.map((column) => column.name)).toEqual(
		mailboxPreDropApprovalColumns,
	)
	expect(
		Object.fromEntries(schema.map((column) => [column.name, column.type])),
	).toEqual(mailboxPreDropApprovalContract.sqliteTypes)
	expect(
		Object.values(mailboxPreDropApprovalContract.provenance).flat().sort(),
	).toEqual(
		mailboxPreDropApprovalColumns
			.filter((column) => column !== 'singleton')
			.sort(),
	)

	sqlite.exec(generatedProducerInsert())
	expect(
		sqlite
			.prepare(
				`SELECT singleton, issued_by,
					expires_at = '2026-08-03T14:30:00.000Z' AS expires_at_matches
				FROM email_user_graph_drop_approval`,
			)
			.get(),
	).toMatchObject({
		singleton: 1,
		issued_by: 'backup-control-plane',
		expires_at_matches: 1,
	})
})

test('0134 rejects stale, forged, malformed, and negative approval provenance', () => {
	for (const override of [
		{ expires_at: '2026-08-03T14:30:00.001Z' },
		{ issued_by: 'operator' },
		{ request_id: '11111111-1111-9111-8111-111111111111' },
		{ sql_sha256: 'g'.repeat(64) },
		{ manifest_signature_sha256: 'c'.repeat(63) },
		{ sql_bytes: 0 },
		{ owner_count: -1 },
		{ authority_owner_count: 1, owner_count: 2 },
		{
			sql_object_key: 'adhoc/mailbox-drop/d1/other/request/backup-61.sql',
		},
	]) {
		using sqlite = createDatabaseBeforeApproval()
		applyMigrationLikeD1(sqlite, approvalMigration)
		expect(() => sqlite.exec(validInsert(override))).toThrow(
			/CHECK constraint failed/u,
		)
	}
})
