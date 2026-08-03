import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
} from '#worker/test-support/system-email-graph-migration.ts'
import { systemEmailOwnerId } from './email-owner.ts'

const authorityMigration = '0133-email-user-graph-authority.sql'

test('0133 aborts on incomplete parity and records only validated USER owners', () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	applyMigrationsBefore(sqlite, authorityMigration)
	sqlite.exec(`
		INSERT INTO users (
			username, email, password_hash, stable_user_id
		) VALUES (
			'authority-user', 'authority@example.test', 'hash', 'user-authority'
		);
		INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			created_at, updated_at
		) VALUES
			(
				'user-authority-message', 'inbound', 'user-authority',
				'sender@example.test', 'stored',
				'2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
			),
			(
				'system-authority-message', 'inbound', '${systemEmailOwnerId}',
				'sender@example.test', 'stored',
				'2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
			);
	`)

	expect(() => applyMigrationLikeD1(sqlite, authorityMigration)).toThrow(
		/CHECK constraint failed/u,
	)
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_schema
				WHERE name = 'email_user_graph_authority'`,
			)
			.get(),
	).toBeUndefined()

	sqlite.exec(`
		UPDATE users
		SET mailbox_parity_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			mailbox_parity_matching_since = strftime(
				'%Y-%m-%dT%H:%M:%fZ',
				'now',
				'-1 hour'
			),
			mailbox_parity_mismatch_count = 0,
			mailbox_parity_last_error = NULL,
			mailbox_parity_message_backfill_completed_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			mailbox_parity_event_backfill_completed_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE stable_user_id = 'user-authority';
	`)
	applyMigrationLikeD1(sqlite, authorityMigration)
	expect(
		sqlite
			.prepare(
				`SELECT owner_count, max_parity_age_hours
				FROM email_user_graph_authority
				WHERE singleton = 1`,
			)
			.get(),
	).toEqual({ owner_count: 1, max_parity_age_hours: 24 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				FROM email_inbound_due_owners`,
			)
			.get(),
	).toEqual({ count: 0 })
})
