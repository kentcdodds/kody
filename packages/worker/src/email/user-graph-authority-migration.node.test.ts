import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
} from '#worker/test-support/system-email-graph-migration.ts'
import { systemEmailOwnerId } from './email-owner.ts'

const authorityMigration = '0133-email-user-graph-authority.sql'

function createAuthorityMigrationDatabase() {
	const sqlite = new DatabaseSync(':memory:')
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

		UPDATE users
		SET mailbox_parity_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			mailbox_parity_matching_since = strftime(
				'%Y-%m-%dT%H:%M:%fZ',
				'now',
				'-2 hours'
			),
			mailbox_parity_mismatch_count = 0,
			mailbox_parity_last_error = NULL,
			mailbox_parity_content_watermark_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'),
			mailbox_parity_content_replay_upper_at = NULL,
			mailbox_parity_content_replay_cursor_updated_at = NULL,
			mailbox_parity_content_replay_cursor_id = NULL,
			mailbox_parity_message_backfill_cursor_created_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours'),
			mailbox_parity_message_backfill_cursor_id = 'last-message',
			mailbox_parity_message_backfill_completed_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			mailbox_parity_event_backfill_cursor_created_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours'),
			mailbox_parity_event_backfill_cursor_id = 'last-event',
			mailbox_parity_event_backfill_completed_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE stable_user_id = 'user-authority';
	`)
	return sqlite
}

function expectAuthorityMigrationRejected(update: string) {
	using sqlite = createAuthorityMigrationDatabase()
	sqlite.exec(update)
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
}

function numericTimestampGateRejects(input: {
	matchingSince: string | null
	checkedAt: string | null
	now: string
}) {
	using sqlite = new DatabaseSync(':memory:')
	const row = sqlite
		.prepare(
			`WITH
			input(matching_since, checked_at, now_at) AS (VALUES (?, ?, ?)),
			clock(now_jd, matching_since_min_jd, checked_at_min_jd) AS (
				SELECT
					julianday(now_at),
					julianday(now_at, '-2 hours'),
					julianday(now_at, '-6 hours')
				FROM input
			)
			SELECT CASE WHEN
				matching_since IS NULL
				OR julianday(matching_since) IS NULL
				OR julianday(matching_since) > matching_since_min_jd
				OR julianday(matching_since) > now_jd
				OR checked_at IS NULL
				OR julianday(checked_at) IS NULL
				OR julianday(checked_at) < checked_at_min_jd
				OR julianday(checked_at) > now_jd
			THEN 1 ELSE 0 END AS rejected
			FROM input
			CROSS JOIN clock`,
		)
		.get(input.matchingSince, input.checkedAt, input.now) as {
		rejected: number
	}
	return row.rejected === 1
}

test('0133 preserves exact soak, freshness, and replay eligibility', () => {
	expectAuthorityMigrationRejected(`
		UPDATE users
		SET mailbox_parity_matching_since =
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
		WHERE stable_user_id = 'user-authority';
	`)

	expectAuthorityMigrationRejected(`
		UPDATE users
		SET mailbox_parity_checked_at =
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 hours')
		WHERE stable_user_id = 'user-authority';
	`)

	expectAuthorityMigrationRejected(`
		UPDATE users
		SET mailbox_parity_content_replay_upper_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			mailbox_parity_content_replay_cursor_updated_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'),
			mailbox_parity_content_replay_cursor_id = 'message-cursor'
		WHERE stable_user_id = 'user-authority';
	`)

	expectAuthorityMigrationRejected(`
		UPDATE users
		SET mailbox_parity_content_replay_cursor_updated_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'),
			mailbox_parity_content_replay_cursor_id = 'dangling-content-cursor'
		WHERE stable_user_id = 'user-authority';
	`)
})

test('0133 timestamp gate uses numeric instants with millisecond boundaries', () => {
	const now = '2026-08-03T12:00:00.500Z'
	expect(
		numericTimestampGateRejects({
			matchingSince: '2026-08-03T10:00:00.500Z',
			checkedAt: '2026-08-03T06:00:00.500Z',
			now,
		}),
	).toBe(false)
	expect(
		numericTimestampGateRejects({
			matchingSince: '2026-08-03T10:00:00.501Z',
			checkedAt: '2026-08-03T06:00:00.500Z',
			now,
		}),
	).toBe(true)
	expect(
		numericTimestampGateRejects({
			matchingSince: '2026-08-03T10:00:00.499Z',
			checkedAt: '2026-08-03T06:00:00.500Z',
			now,
		}),
	).toBe(false)
	expect(
		numericTimestampGateRejects({
			matchingSince: '2026-08-03T10:00:00.500Z',
			checkedAt: '2026-08-03T06:00:00.499Z',
			now,
		}),
	).toBe(true)
	expect(
		numericTimestampGateRejects({
			matchingSince: '2026-08-03T10:00:00.500Z',
			checkedAt: '2026-08-03T06:00:00.501Z',
			now,
		}),
	).toBe(false)
})

test('0133 timestamp gate treats equivalent ISO offsets as equal instants', () => {
	expect(
		numericTimestampGateRejects({
			matchingSince: '2026-08-03T12:00:00.500+02:00',
			checkedAt: '2026-08-03T08:00:00.500+02:00',
			now: '2026-08-03T12:00:00.500Z',
		}),
	).toBe(false)

	using sqlite = createAuthorityMigrationDatabase()
	sqlite.exec(`
		UPDATE users
		SET mailbox_parity_matching_since =
				strftime('%Y-%m-%dT%H:%M:%f', 'now') || '+02:00',
			mailbox_parity_checked_at =
				strftime('%Y-%m-%dT%H:%M:%f', 'now', '+2 hours') || '+02:00'
		WHERE stable_user_id = 'user-authority';
	`)
	expect(() => applyMigrationLikeD1(sqlite, authorityMigration)).not.toThrow()
})

test('0133 rejects null, invalid, and future parity timestamps', () => {
	for (const update of [
		`mailbox_parity_matching_since = NULL`,
		`mailbox_parity_checked_at = NULL`,
		`mailbox_parity_matching_since = 'not-a-timestamp'`,
		`mailbox_parity_checked_at = 'not-a-timestamp'`,
		`mailbox_parity_matching_since =
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour')`,
		`mailbox_parity_checked_at =
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour')`,
	]) {
		expectAuthorityMigrationRejected(`
			UPDATE users
			SET ${update}
			WHERE stable_user_id = 'user-authority';
		`)
	}
})

test('0133 blocks a deleting frozen owner until privacy cleanup finishes', () => {
	using sqlite = createAuthorityMigrationDatabase()
	sqlite.exec(`
		UPDATE users
		SET deleting_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE stable_user_id = 'user-authority';
	`)
	expect(() => applyMigrationLikeD1(sqlite, authorityMigration)).toThrow(
		/CHECK constraint failed/u,
	)

	sqlite.exec(`
		DELETE FROM email_messages
		WHERE user_id = 'user-authority';
	`)
	expect(() => applyMigrationLikeD1(sqlite, authorityMigration)).not.toThrow()
	expect(
		sqlite
			.prepare(
				`SELECT owner_count
				FROM email_user_graph_authority
				WHERE singleton = 1`,
			)
			.get(),
	).toEqual({ owner_count: 0 })
})

test('0133 records an exactly eligible owner and seeds its cutover audit', () => {
	using sqlite = createAuthorityMigrationDatabase()
	applyMigrationLikeD1(sqlite, authorityMigration)
	expect(
		sqlite
			.prepare(
				`SELECT owner_count, max_parity_age_hours
				FROM email_user_graph_authority
				WHERE singleton = 1`,
			)
			.get(),
	).toEqual({ owner_count: 1, max_parity_age_hours: 6 })
	expect(
		sqlite
			.prepare(
				`SELECT user_id, reason, attempt_count, last_error,
					due_at = updated_at AS timestamps_match
				FROM email_inbound_due_owners`,
			)
			.get(),
	).toEqual({
		user_id: 'user-authority',
		reason: 'cutover-audit',
		attempt_count: 0,
		last_error: null,
		timestamps_match: 1,
	})
})
