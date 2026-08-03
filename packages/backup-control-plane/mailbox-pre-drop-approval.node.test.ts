import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { test } from 'vitest'

import { environment, manifest } from './backup-control-plane-test-support.ts'
import { upsertMailboxPreDropApproval } from './mailbox-pre-drop-approval.ts'
import { mailboxPreDropRuntimePayload } from './mailbox-pre-drop-policy.ts'
import { objectKeyForPayload } from './backup-policy.ts'

function createApprovalDatabase(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_user_graph_authority (
			singleton INTEGER PRIMARY KEY,
			owner_count INTEGER NOT NULL,
			frozen_at TEXT NOT NULL,
			max_parity_age_hours INTEGER NOT NULL
		);
		INSERT INTO email_user_graph_authority
			VALUES (1, 0, '2026-08-03T12:00:00.000Z', 6);
		CREATE TABLE email_threads (user_id TEXT NOT NULL);
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			provider_message_id TEXT
		);
		CREATE TABLE email_delivery_events (user_id TEXT NOT NULL);
		CREATE TABLE email_attachments (message_id TEXT NOT NULL);
		CREATE TABLE email_outbound_provider_index_repair_owners (
			user_id TEXT PRIMARY KEY
		);
		CREATE TABLE email_inbound_due_owners (reason TEXT NOT NULL);
		CREATE TABLE system_email_graph_authority (
			singleton INTEGER PRIMARY KEY,
			authority TEXT NOT NULL,
			graph_mismatch_count INTEGER NOT NULL,
			provider_link_count INTEGER NOT NULL
		);
		INSERT INTO system_email_graph_authority
			VALUES (1, 'dedicated', 0, 0);
		CREATE TABLE email_outbound_provider_index (
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL
		);
		CREATE TABLE email_inboxes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
		CREATE TABLE email_sender_identities (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL
		);
		CREATE TABLE system_email_threads (id TEXT PRIMARY KEY, inbox_id TEXT);
		CREATE TABLE system_email_messages (
			id TEXT PRIMARY KEY,
			inbox_id TEXT,
			sender_identity_id TEXT,
			thread_id TEXT,
			provider_message_id TEXT
		);
		CREATE TABLE system_email_attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL
		);
		CREATE TABLE system_email_delivery_events (
			id TEXT PRIMARY KEY,
			inbox_id TEXT,
			message_id TEXT
		);
	`)
	sqlite.exec(
		readFileSync(
			new URL(
				'../worker/migrations/0134-email-user-graph-drop-approval.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return sqlite
}

test('atomic approval SQL rechecks the snapshot and writes verified internal evidence', async () => {
	using sqlite = createApprovalDatabase()
	const env = environment()
	const request = {
		requestId: '11111111-1111-4111-8111-111111111111',
		nonce: '0123456789abcdef0123456789abcdef',
		requestedAt: '2026-08-03T12:01:00.000Z',
	}
	const payload = mailboxPreDropRuntimePayload(env, request)
	const signed = manifest({
		bytes: 5,
		sha256: 'a'.repeat(64),
		r2Etag: 'b'.repeat(32),
	})
	signed.payload.sql.objectKey = objectKeyForPayload(
		payload,
		signed.payload.export.bookmark,
	)
	signed.payload.export.scheduledAt = request.requestedAt
	signed.payload.export.startedAt = '2026-08-03T12:01:01.000Z'
	signed.payload.export.completedAt = '2026-08-03T12:29:00.000Z'
	const receipt = await upsertMailboxPreDropApproval({
		env,
		payload,
		snapshot: {
			authorityFrozenAt: '2026-08-03T12:00:00.000Z',
			authorityOwnerCount: 0,
			ownerCount: 0,
			threadCount: 0,
			messageCount: 0,
			attachmentCount: 0,
			eventCount: 0,
		},
		manifest: signed,
		manifestSignatureSha256: 'c'.repeat(64),
		verifiedAt: '2026-08-03T12:30:00.000Z',
		options: {
			fetcher: async (_request, init) => {
				const body = JSON.parse(String(init?.body)) as { sql: string }
				const rows = sqlite.prepare(body.sql).all()
				return Response.json({
					success: true,
					result: [{ results: rows }],
				})
			},
		},
	})
	assert.equal(receipt.expiresAt, '2026-08-03T14:30:00.000Z')
	assert.deepEqual(
		{
			...sqlite
				.prepare(
					`SELECT request_id, manifest_key, sql_sha256, issued_by
				FROM email_user_graph_drop_approval`,
				)
				.get(),
		},
		{
			request_id: request.requestId,
			manifest_key: payload.manifestKey,
			sql_sha256: 'a'.repeat(64),
			issued_by: 'backup-control-plane',
		},
	)

	sqlite.exec(`UPDATE email_user_graph_authority SET frozen_at =
		'2026-08-03T12:00:01.000Z' WHERE singleton = 1`)
	await assert.rejects(
		upsertMailboxPreDropApproval({
			env,
			payload,
			snapshot: {
				authorityFrozenAt: '2026-08-03T12:00:00.000Z',
				authorityOwnerCount: 0,
				ownerCount: 0,
				threadCount: 0,
				messageCount: 0,
				attachmentCount: 0,
				eventCount: 0,
			},
			manifest: signed,
			manifestSignatureSha256: 'c'.repeat(64),
			verifiedAt: '2026-08-03T12:31:00.000Z',
			options: {
				fetcher: async (_request, init) => {
					const body = JSON.parse(String(init?.body)) as { sql: string }
					const rows = sqlite.prepare(body.sql).all()
					return Response.json({
						success: true,
						result: [{ results: rows }],
					})
				},
			},
		}),
		(error: unknown) =>
			error instanceof Error &&
			/atomic pre-drop approval UPSERT was rejected/u.test(error.message),
	)
})
