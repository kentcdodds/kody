import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	loadSystemEmailGraphParityReport,
	reconcileSystemEmailGraphFromLegacy,
} from './system-email-graph-repo.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const systemEmailGraphMigration = '0130-system-email-graph-expand.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

test('system email graph report returns aggregate parity and provider disposition', async () => {
	using sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, systemEmailGraphMigration)
	sqlite.exec('PRAGMA foreign_keys = ON')
	const createdAt = '2026-08-02T20:00:00.000Z'
	const updatedAt = '2026-08-02T20:05:00.000Z'
	sqlite.exec(`
		INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES
			('system-inbox', 'system:email', 'support', '', 1,
				'${createdAt}', '${updatedAt}'),
			('user-inbox', 'user-1', 'personal', '', 1,
				'${createdAt}', '${updatedAt}');

		INSERT INTO email_threads (
			id, user_id, inbox_id, subject_normalized, root_message_id_header,
			last_message_at, created_at, updated_at
		) VALUES
			('system-thread', 'system:email', 'system-inbox', 'incident',
				'<system-root@example.com>', '${updatedAt}', '${createdAt}', '${updatedAt}'),
			('user-thread', 'user-1', 'user-inbox', 'private',
				'<user-root@example.com>', '${updatedAt}', '${createdAt}', '${updatedAt}');

		INSERT INTO email_messages (
			id, direction, user_id, inbox_id, thread_id, from_address,
			to_addresses_json, subject, message_id_header, references_json,
			headers_json, text_body, raw_size, processing_status,
			provider_message_id, received_at, sent_at, created_at, updated_at,
			raw_mime_key, classification
		) VALUES
			(
				'system-inbound', 'inbound', 'system:email', 'system-inbox',
				'system-thread', 'sender@example.net', '["support@example.com"]',
				'Incident', '<system-inbound@example.net>', '[]', '{}',
				'operator body', 512, 'stored', NULL, '${createdAt}', NULL,
				'${createdAt}', '${updatedAt}',
				'email-raw:v1:system:email/system-inbound', 'accepted'
			),
			(
				'system-outbound', 'outbound', 'system:email', 'system-inbox',
				'system-thread', 'support@example.com',
				'["recipient@example.net"]', 'Reply',
				'<system-outbound@example.com>', '[]', '{}', 'reply body', 128,
				'sent', 'provider-system-1', NULL, '${updatedAt}', '${createdAt}',
				'${updatedAt}', NULL, 'accepted'
			),
			(
				'user-message', 'inbound', 'user-1', 'user-inbox', 'user-thread',
				'private@example.net', '["user@example.com"]', 'Private',
				'<user-message@example.net>', '[]', '{}', 'private body', 64,
				'stored', NULL, '${createdAt}', NULL, '${createdAt}', '${updatedAt}',
				NULL, 'accepted'
			);

		INSERT INTO email_attachments (
			id, message_id, filename, content_type, size, storage_kind,
			storage_key, created_at
		) VALUES
			('system-attachment', 'system-inbound', 'evidence.txt', 'text/plain',
				42, 'external',
				'email-attachment:v1:system:email/system-inbound/system-attachment',
				'${createdAt}'),
			('user-attachment', 'user-message', 'private.txt', 'text/plain', 7,
				'raw-mime', NULL, '${createdAt}');

		INSERT INTO email_delivery_events (
			id, message_id, user_id, inbox_id, event_type, provider,
			provider_event_id, detail_json, created_at, needs_effect_reconcile,
			usage_month, usage_bytes, usage_duration_ms, state, fingerprint,
			expected_attachment_count, finalization_token,
			subscription_effect_state, subscription_effect_attempt_count, updated_at
		) VALUES
			(
				'system-delivery', 'system-inbound', 'system:email', 'system-inbox',
				'received', 'cloudflare-email-routing', 'provider-event-1',
				'{"state":"received"}', '${createdAt}', 1, '2026-08', 512, 321,
				'received', 'fingerprint-1', 1, 'finalization-1', 'processing', 2,
				'${updatedAt}'
			),
			(
				'user-delivery', 'user-message', 'user-1', 'user-inbox', 'received',
				'cloudflare-email-routing', 'provider-event-user', '{}',
				'${createdAt}', 0, '2026-08', 64, 10, 'received',
				'user-fingerprint', 0, 'user-finalization', 'complete', 1,
				'${updatedAt}'
			);

		INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, inbox_id,
			created_at, updated_at
		) VALUES (
			'cloudflare-email', 'provider-system-1', 'system:email',
			'system-outbound', 'system-inbox', '${createdAt}', '${updatedAt}'
		);
	`)
	sqlite.exec(
		readFileSync(
			new URL(systemEmailGraphMigration, migrationsDirectory),
			'utf8',
		),
	)
	const db = createD1FromSqlite(sqlite)

	const matching = await loadSystemEmailGraphParityReport({ db })
	expect(matching).toEqual({
		threads: {
			legacyCount: 1,
			dedicatedCount: 1,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		messages: {
			legacyCount: 2,
			dedicatedCount: 2,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		attachments: {
			legacyCount: 1,
			dedicatedCount: 1,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		deliveryEvents: {
			legacyCount: 1,
			dedicatedCount: 1,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		outboundProviderIndex: {
			legacyProviderLinkedMessageCount: 1,
			dedicatedProviderLinkedMessageCount: 1,
			legacyAuthorityIndexCount: 1,
			missingFromLegacyAuthorityIndexCount: 0,
			missingFromLegacyMessagesCount: 0,
			mismatchedLegacyAuthorityIndexCount: 0,
			classification: 'legacy-authority-parity',
			authorityDisposition: 'legacy-email-messages-until-4b-routing',
			parity: true,
		},
		parity: true,
	})
	expect(JSON.stringify(matching)).not.toMatch(
		/@|operator body|evidence|provider-system-1|system-thread/u,
	)

	sqlite.exec(`
		INSERT INTO system_email_threads (
			id, inbox_id, subject_normalized, last_message_at, created_at, updated_at
		) VALUES (
			'user-thread', 'user-inbox', 'private', '${updatedAt}', '${createdAt}',
			'${updatedAt}'
		);
		UPDATE system_email_messages
		SET thread_id = NULL
		WHERE id = 'system-inbound';
		UPDATE system_email_attachments
		SET storage_key = 'drifted-key'
		WHERE id = 'system-attachment';
		DELETE FROM system_email_delivery_events
		WHERE id = 'system-delivery';
		UPDATE email_outbound_provider_index
		SET inbox_id = NULL
		WHERE provider_message_id = 'provider-system-1';
	`)

	const mismatched = await loadSystemEmailGraphParityReport({ db })
	expect(mismatched).toMatchObject({
		threads: {
			legacyCount: 1,
			dedicatedCount: 2,
			missingFromLegacyCount: 1,
			ownershipMismatchCount: 1,
			parity: false,
		},
		messages: {
			relationshipMismatchCount: 1,
			parity: false,
		},
		attachments: {
			keyFieldMismatchCount: 1,
			parity: false,
		},
		deliveryEvents: {
			missingFromDedicatedCount: 1,
			parity: false,
		},
		outboundProviderIndex: {
			missingFromLegacyAuthorityIndexCount: 1,
			mismatchedLegacyAuthorityIndexCount: 1,
			classification: 'legacy-authority-mismatch',
			authorityDisposition: 'legacy-email-messages-until-4b-routing',
			parity: false,
		},
		parity: false,
	})

	sqlite.exec(`
		UPDATE email_outbound_provider_index
		SET inbox_id = 'system-inbox'
		WHERE provider_message_id = 'provider-system-1';
		UPDATE email_messages
		SET subject = 'Updated incident'
		WHERE id = 'system-inbound';
		DELETE FROM email_attachments
		WHERE id = 'system-attachment';
		INSERT INTO email_attachments (
			id, message_id, filename, content_type, size, storage_kind, created_at
		) VALUES (
			'system-attachment-new', 'system-inbound', 'new.txt', 'text/plain',
			8, 'raw-mime', '${updatedAt}'
		);
		INSERT INTO system_email_messages (
			id, direction, from_address, processing_status, created_at, updated_at
		) VALUES (
			'dedicated-drift-message', 'inbound', 'drift@example.net', 'stored',
			'${createdAt}', '${updatedAt}'
		);
		INSERT INTO system_email_attachments (
			id, message_id, content_type, size, storage_kind, created_at
		) VALUES (
			'dedicated-drift-attachment', 'dedicated-drift-message', 'text/plain',
			1, 'raw-mime', '${createdAt}'
		);
	`)
	const batch = vi.spyOn(db, 'batch')
	const repaired = await reconcileSystemEmailGraphFromLegacy({ db })
	expect(batch).toHaveBeenCalledTimes(1)
	expect(repaired.metrics).toEqual({
		deleted: {
			threads: 1,
			messages: 1,
			attachments: 2,
			deliveryEvents: 0,
		},
		upserted: {
			threads: 0,
			messages: 1,
			attachments: 1,
			deliveryEvents: 1,
		},
		referencedOwnerMismatchCount: 0,
	})
	expect(repaired.postReport.parity).toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT subject, thread_id
				FROM system_email_messages
				WHERE id = 'system-inbound'`,
			)
			.get(),
	).toEqual({ subject: 'Updated incident', thread_id: 'system-thread' })
	expect(
		sqlite.prepare(`SELECT id FROM system_email_attachments ORDER BY id`).all(),
	).toEqual([{ id: 'system-attachment-new' }])

	const repeated = await reconcileSystemEmailGraphFromLegacy({ db })
	expect(batch).toHaveBeenCalledTimes(2)
	expect(repeated.metrics).toEqual({
		deleted: {
			threads: 0,
			messages: 0,
			attachments: 0,
			deliveryEvents: 0,
		},
		upserted: {
			threads: 0,
			messages: 0,
			attachments: 0,
			deliveryEvents: 0,
		},
		referencedOwnerMismatchCount: 0,
	})
	expect(repeated.postReport.parity).toBe(true)

	sqlite.exec(`
		INSERT INTO email_sender_identities (
			id, user_id, email, display_name, status, created_at, updated_at
		) VALUES (
			'foreign-sender', 'user-1', 'foreign@example.com', 'Foreign',
			'verified', '${createdAt}', '${updatedAt}'
		);
		INSERT INTO email_threads (
			id, user_id, inbox_id, subject_normalized, last_message_at,
			created_at, updated_at
		) VALUES (
			'invalid-system-thread', 'system:email', 'user-inbox', 'invalid',
			'${updatedAt}', '${createdAt}', '${updatedAt}'
		);
		INSERT INTO email_messages (
			id, direction, user_id, inbox_id, sender_identity_id, from_address,
			to_addresses_json, subject, references_json, headers_json, raw_size,
			processing_status, created_at, updated_at
		) VALUES (
			'invalid-system-message', 'outbound', 'system:email', 'user-inbox',
			'foreign-sender', 'support@example.com', '["recipient@example.net"]',
			'Invalid owner refs', '[]', '{}', 1, 'stored', '${createdAt}',
			'${updatedAt}'
		);
		INSERT INTO email_attachments (
			id, message_id, content_type, size, storage_kind, created_at
		) VALUES (
			'invalid-system-attachment', 'invalid-system-message', 'text/plain',
			1, 'raw-mime', '${createdAt}'
		);
		INSERT INTO email_delivery_events (
			id, message_id, user_id, inbox_id, event_type, provider, detail_json,
			created_at, needs_effect_reconcile
		) VALUES (
			'invalid-system-event', 'invalid-system-message', 'system:email',
			'user-inbox', 'send_requested', 'kody', '{}', '${createdAt}', 0
		);
	`)
	const fenced = await reconcileSystemEmailGraphFromLegacy({ db })
	expect(fenced.metrics.referencedOwnerMismatchCount).toBe(4)
	expect(fenced.postReport).toMatchObject({
		threads: { referencedOwnerMismatchCount: 1, parity: false },
		messages: { referencedOwnerMismatchCount: 1, parity: false },
		attachments: { referencedOwnerMismatchCount: 1, parity: false },
		deliveryEvents: { referencedOwnerMismatchCount: 1, parity: false },
		parity: false,
	})
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				FROM system_email_messages
				WHERE id = 'invalid-system-message'`,
			)
			.get(),
	).toEqual({ count: 0 })
})
