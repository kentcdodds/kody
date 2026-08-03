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

function databaseOptions(sqlite: DatabaseSync) {
	return {
		fetcher: async (_request: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { sql: string }
			const rows = sqlite.prepare(body.sql).all()
			return Response.json({
				success: true,
				result: [{ results: rows }],
			})
		},
	}
}

function approvalInput(input: {
	env: ReturnType<typeof environment>
	requestId: string
	nonce: string
	requestedAt: string
	verifiedAt: string
	hashCharacter: string
	options: ReturnType<typeof databaseOptions>
}) {
	const payload = mailboxPreDropRuntimePayload(input.env, {
		requestId: input.requestId,
		nonce: input.nonce,
		requestedAt: input.requestedAt,
	})
	const signed = manifest({
		bytes: 5,
		sha256: input.hashCharacter.repeat(64),
		r2Etag: 'b'.repeat(32),
	})
	signed.payload.sql.objectKey = objectKeyForPayload(
		payload,
		signed.payload.export.bookmark,
	)
	signed.payload.export.scheduledAt = input.requestedAt
	signed.payload.export.startedAt = new Date(
		Date.parse(input.requestedAt) + 1_000,
	).toISOString()
	signed.payload.export.completedAt = '2026-08-03T12:29:00.000Z'
	return {
		env: input.env,
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
		verifiedAt: input.verifiedAt,
		options: input.options,
	}
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
		options: databaseOptions(sqlite),
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
			options: databaseOptions(sqlite),
		}),
		(error: unknown) =>
			error instanceof Error &&
			/atomic pre-drop approval was stale, conflicted, or not confirmed/u.test(
				error.message,
			),
	)
})

test('approval UPSERT is monotonic under replay and resumed workflow races', async () => {
	using sqlite = createApprovalDatabase()
	const env = environment()
	const options = databaseOptions(sqlite)
	const older = approvalInput({
		env,
		requestId: '11111111-1111-4111-8111-111111111111',
		nonce: '1'.repeat(32),
		requestedAt: '2026-08-03T12:01:00.000Z',
		verifiedAt: '2026-08-03T12:30:00.000Z',
		hashCharacter: 'a',
		options,
	})
	const newer = approvalInput({
		env,
		requestId: '22222222-2222-4222-8222-222222222222',
		nonce: '2'.repeat(32),
		requestedAt: '2026-08-03T12:02:00.000Z',
		verifiedAt: '2026-08-03T12:31:00.000Z',
		hashCharacter: 'd',
		options,
	})

	await upsertMailboxPreDropApproval(older)
	await Promise.all([
		upsertMailboxPreDropApproval(newer),
		assert.rejects(
			upsertMailboxPreDropApproval(older),
			/was stale, conflicted, or not confirmed/u,
		),
	])
	expectCurrentRequest(sqlite, newer.payload.requestId)

	const replay = await upsertMailboxPreDropApproval(newer)
	assert.equal(replay.requestId, newer.payload.requestId)
	expectCurrentRequest(sqlite, newer.payload.requestId)

	const sameTimestampDifferentRequest = approvalInput({
		env,
		requestId: '33333333-3333-4333-8333-333333333333',
		nonce: '3'.repeat(32),
		requestedAt: '2026-08-03T12:03:00.000Z',
		verifiedAt: newer.verifiedAt,
		hashCharacter: 'e',
		options,
	})
	await assert.rejects(
		upsertMailboxPreDropApproval(sameTimestampDifferentRequest),
		/was stale, conflicted, or not confirmed/u,
	)
	expectCurrentRequest(sqlite, newer.payload.requestId)

	const sameRequestDifferentBytes = approvalInput({
		env,
		requestId: newer.payload.requestId,
		nonce: newer.payload.nonce,
		requestedAt: newer.payload.requestedAt,
		verifiedAt: newer.verifiedAt,
		hashCharacter: 'f',
		options,
	})
	await assert.rejects(
		upsertMailboxPreDropApproval(sameRequestDifferentBytes),
		/was stale, conflicted, or not confirmed/u,
	)
	expectCurrentRequest(sqlite, newer.payload.requestId)
})

function expectCurrentRequest(sqlite: DatabaseSync, requestId: string): void {
	assert.equal(
		sqlite
			.prepare(
				`SELECT request_id FROM email_user_graph_drop_approval
				WHERE singleton = 1`,
			)
			.get()?.request_id,
		requestId,
	)
}
