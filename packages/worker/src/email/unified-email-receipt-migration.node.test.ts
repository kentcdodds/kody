import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

async function readMigration(name: string) {
	return await readFile(
		new URL(`../../migrations/${name}`, import.meta.url),
		'utf8',
	)
}

test('0031 unified email receipt migration rewrites policy events without duplicating receipts', async () => {
	const db = new DatabaseSync(':memory:')
	db.exec(await readMigration('0030-email-primitives.sql'))

	db.exec(`
		INSERT INTO email_inboxes (
			id, user_id, package_id, name, description, mode, enabled, created_at, updated_at
		) VALUES (
			'inbox-1', 'user-1', NULL, 'Support', '', 'quarantine', 1, '2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z'
		);

		INSERT INTO email_messages (
			id, direction, user_id, inbox_id, thread_id, sender_identity_id,
			from_address, envelope_from, to_addresses_json, cc_addresses_json,
			bcc_addresses_json, reply_to_addresses_json, subject, message_id_header,
			in_reply_to_header, references_json, headers_json, auth_results,
			text_body, html_body, raw_mime, raw_size, policy_decision,
			processing_status, provider_message_id, error, received_at, sent_at,
			created_at, updated_at
		) VALUES
		(
			'message-with-received', 'inbound', 'user-1', 'inbox-1', NULL, NULL,
			'sender@example.com', 'sender@example.com', '[]', '[]',
			'[]', '[]', 'With received', NULL,
			NULL, '[]', '{}', NULL,
			'body', NULL, NULL, 0, 'accepted',
			'stored', NULL, NULL, '2026-04-30T00:00:00.000Z', NULL,
			'2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z'
		),
		(
			'message-policy-only', 'inbound', 'user-1', 'inbox-1', NULL, NULL,
			'sender2@example.com', 'sender2@example.com', '[]', '[]',
			'[]', '[]', 'Policy only', NULL,
			NULL, '[]', '{}', NULL,
			'body', NULL, NULL, 0, 'accepted',
			'stored', NULL, NULL, '2026-04-30T00:00:00.000Z', NULL,
			'2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z'
		);

		INSERT INTO email_delivery_events (
			id, message_id, user_id, inbox_id, event_type, provider,
			provider_message_id, detail_json, created_at
		) VALUES
		(
			'event-received', 'message-with-received', 'user-1', 'inbox-1', 'received', 'cloudflare-email-routing',
			NULL, '{}', '2026-04-30T00:00:00.000Z'
		),
		(
			'event-policy-duplicate', 'message-with-received', 'user-1', 'inbox-1', 'policy_matched', 'cloudflare-email-routing',
			NULL, '{}', '2026-04-30T00:00:01.000Z'
		),
		(
			'event-policy-only', 'message-policy-only', 'user-1', 'inbox-1', 'policy_matched', 'cloudflare-email-routing',
			NULL, '{}', '2026-04-30T00:00:02.000Z'
		);
	`)

	db.exec(await readMigration('0031-unified-email-receipt.sql'))

	const messageColumns = db
		.prepare(
			`SELECT name FROM pragma_table_info('email_messages') ORDER BY cid ASC`,
		)
		.all() as Array<{ name: string }>
	expect(messageColumns.map((column) => column.name)).not.toContain(
		'policy_decision',
	)

	const inboxColumns = db
		.prepare(
			`SELECT name FROM pragma_table_info('email_inboxes') ORDER BY cid ASC`,
		)
		.all() as Array<{ name: string }>
	expect(inboxColumns.map((column) => column.name)).not.toContain('mode')

	const events = db
		.prepare(
			`SELECT message_id, event_type, created_at
			FROM email_delivery_events
			ORDER BY created_at ASC, id ASC`,
		)
		.all() as Array<{
		message_id: string | null
		event_type: string
		created_at: string
	}>

	expect(events).toEqual([
		{
			message_id: 'message-with-received',
			event_type: 'received',
			created_at: '2026-04-30T00:00:00.000Z',
		},
		{
			message_id: 'message-policy-only',
			event_type: 'received',
			created_at: '2026-04-30T00:00:02.000Z',
		},
	])

	const policyTable = db
		.prepare(
			`SELECT name
			FROM sqlite_master
			WHERE type = 'table' AND name = 'email_sender_policies'`,
		)
		.get() as { name?: string } | undefined
	expect(policyTable).toBeUndefined()
})
