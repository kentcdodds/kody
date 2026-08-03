import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	deleteFrozenUserEmailGraphForAccount,
	pruneFrozenUserEmailGraphForRetention,
} from './legacy-user-email-graph-cleanup.ts'

function createLegacyGraph() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_threads (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL
		);
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, thread_id TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE email_attachments (
			id TEXT PRIMARY KEY, message_id TEXT NOT NULL
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL
		);
		CREATE TABLE email_outbound_provider_index (
			message_id TEXT PRIMARY KEY
		);
	`)
	return sqlite
}

test('account privacy cleanup deletes only the requested frozen USER owner', async () => {
	using sqlite = createLegacyGraph()
	sqlite.exec(`
		INSERT INTO email_threads VALUES
			('thread-user', 'user-1'),
			('thread-other', 'user-2'),
			('thread-system', 'system:email');
		INSERT INTO email_messages VALUES
			('message-user', 'user-1', 'thread-user', '2020-01-01T00:00:00.000Z'),
			('message-other', 'user-2', 'thread-other', '2020-01-01T00:00:00.000Z'),
			('message-system', 'system:email', 'thread-system', '2020-01-01T00:00:00.000Z');
		INSERT INTO email_attachments VALUES
			('attachment-user', 'message-user'),
			('attachment-other', 'message-other');
		INSERT INTO email_delivery_events VALUES
			('event-user', 'user-1', '2020-01-01T00:00:00.000Z'),
			('event-system', 'system:email', '2020-01-01T00:00:00.000Z');
	`)
	const result = await deleteFrozenUserEmailGraphForAccount({
		db: createD1FromSqlite(sqlite),
		userId: 'user-1',
	})
	expect(result).toEqual({
		email_delivery_events: 1,
		email_attachments: 1,
		email_messages: 1,
		email_threads: 1,
	})
	expect(
		sqlite.prepare(`SELECT id FROM email_messages ORDER BY id`).all(),
	).toEqual([{ id: 'message-other' }, { id: 'message-system' }])
})

test('legacy retention prunes metadata but preserves indexed and system rows', async () => {
	using sqlite = createLegacyGraph()
	sqlite.exec(`
		INSERT INTO email_threads VALUES
			('thread-drop', 'user-1'),
			('thread-indexed', 'user-1'),
			('thread-system', 'system:email');
		INSERT INTO email_messages VALUES
			('message-drop', 'user-1', 'thread-drop', '2020-01-01T00:00:00.000Z'),
			('message-indexed', 'user-1', 'thread-indexed', '2020-01-01T00:00:00.000Z'),
			('message-system', 'system:email', 'thread-system', '2020-01-01T00:00:00.000Z');
		INSERT INTO email_attachments VALUES
			('attachment-drop', 'message-drop'),
			('attachment-indexed', 'message-indexed');
		INSERT INTO email_delivery_events VALUES
			('event-drop', 'user-1', '2020-01-01T00:00:00.000Z'),
			('event-system', 'system:email', '2020-01-01T00:00:00.000Z');
		INSERT INTO email_outbound_provider_index VALUES ('message-indexed');
	`)
	const result = await pruneFrozenUserEmailGraphForRetention({
		db: createD1FromSqlite(sqlite),
		now: new Date('2026-08-03T00:00:00.000Z'),
	})
	expect(result).toMatchObject({
		emailDeliveryEvents: 1,
		emailMessages: 1,
		emailAttachments: 1,
		emailThreads: 1,
	})
	expect(
		sqlite.prepare(`SELECT id FROM email_messages ORDER BY id`).all(),
	).toEqual([{ id: 'message-indexed' }, { id: 'message-system' }])
})
