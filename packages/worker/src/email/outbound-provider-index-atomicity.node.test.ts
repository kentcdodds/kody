import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { emailOutboundProviderCloudflare } from './outbound-provider-index.ts'
import {
	getEmailMessageById,
	getOutboundEmailMessageByProviderMessageId,
	insertEmailMessage,
	updateEmailMessageDelivery,
} from './repo.ts'

function createEmailDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	sqlite.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
			user_id TEXT NOT NULL,
			inbox_id TEXT,
			thread_id TEXT,
			sender_identity_id TEXT,
			from_address TEXT NOT NULL,
			envelope_from TEXT,
			to_addresses_json TEXT NOT NULL DEFAULT '[]',
			cc_addresses_json TEXT NOT NULL DEFAULT '[]',
			bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
			reply_to_addresses_json TEXT NOT NULL DEFAULT '[]',
			subject TEXT NOT NULL DEFAULT '',
			message_id_header TEXT,
			in_reply_to_header TEXT,
			references_json TEXT NOT NULL DEFAULT '[]',
			headers_json TEXT NOT NULL DEFAULT '{}',
			auth_results TEXT,
			text_body TEXT,
			html_body TEXT,
			raw_mime_key TEXT,
			raw_size INTEGER NOT NULL DEFAULT 0,
			processing_status TEXT NOT NULL,
			classification TEXT NOT NULL DEFAULT 'accepted',
			classification_reason TEXT,
			provider_message_id TEXT,
			delivery_status TEXT,
			delivery_status_at TEXT,
			error TEXT,
			received_at TEXT,
			sent_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_email_messages_provider_message_id
		ON email_messages(provider_message_id)
		WHERE direction = 'outbound' AND provider_message_id IS NOT NULL;
		CREATE TABLE email_outbound_provider_index (
			provider TEXT NOT NULL,
			provider_message_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			inbox_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (provider, provider_message_id),
			FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
		);
		CREATE UNIQUE INDEX idx_email_outbound_provider_index_message_id
		ON email_outbound_provider_index(message_id);
	`)
	return sqlite
}

function wrapDbFailingIndexStatements(sqlite: DatabaseSync): D1Database {
	const base = createD1FromSqlite(sqlite)
	return {
		...base,
		prepare(query: string) {
			const prepared = base.prepare(query)
			if (!/email_outbound_provider_index/iu.test(query)) {
				return prepared
			}
			return {
				...prepared,
				bind(...params: Array<unknown>) {
					const bound = prepared.bind(...params)
					return {
						...bound,
						async run() {
							throw new Error('injected provider-index statement failure')
						},
					}
				},
			}
		},
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			return base.batch(statements)
		},
	} as unknown as D1Database
}

test('insert with provider id rolls back message when index statement fails', async () => {
	const sqlite = createEmailDb()
	const db = wrapDbFailingIndexStatements(sqlite)
	const userId = 'user-atomic-insert'
	const providerMessageId = 'provider-atomic-insert'

	await expect(
		insertEmailMessage({
			db,
			message: {
				id: 'msg-atomic-insert',
				direction: 'outbound',
				userId,
				fromAddress: 'user@example.com',
				toAddresses: ['to@example.com'],
				subject: 'Atomic insert',
				processingStatus: 'sent',
				providerMessageId,
				sentAt: '2026-08-01T12:00:00.000Z',
			},
		}),
	).rejects.toThrow('injected provider-index statement failure')

	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM email_messages`).get() as {
			count: number
		},
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM email_outbound_provider_index`)
			.get() as { count: number },
	).toEqual({ count: 0 })
})

test('updateEmailMessageDelivery rolls back message mutation when index fails', async () => {
	const sqlite = createEmailDb()
	const healthy = createD1FromSqlite(sqlite)
	const message = await insertEmailMessage({
		db: healthy,
		message: {
			id: 'msg-atomic-update',
			direction: 'outbound',
			userId: 'user-atomic-update',
			fromAddress: 'user@example.com',
			toAddresses: ['to@example.com'],
			subject: 'Atomic update',
			processingStatus: 'stored',
			providerMessageId: null,
		},
	})
	expect(message.processingStatus).toBe('stored')
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM email_outbound_provider_index`)
			.get() as { count: number },
	).toEqual({ count: 0 })

	const failingDb = wrapDbFailingIndexStatements(sqlite)
	await expect(
		updateEmailMessageDelivery({
			db: failingDb,
			messageId: message.id,
			status: 'sent',
			providerMessageId: 'provider-atomic-update',
			error: null,
			sentAt: '2026-08-01T12:05:00.000Z',
		}),
	).rejects.toThrow('injected provider-index statement failure')

	const stored = await getEmailMessageById({
		db: healthy,
		userId: 'user-atomic-update',
		messageId: message.id,
	})
	expect(stored).toMatchObject({
		processingStatus: 'stored',
		providerMessageId: null,
		sentAt: null,
	})
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM email_outbound_provider_index`)
			.get() as { count: number },
	).toEqual({ count: 0 })
})

test('provider-accepted update cannot leave sent message without index or mark failed from index-only error', async () => {
	const sqlite = createEmailDb()
	const db = createD1FromSqlite(sqlite)
	const userId = 'user-accepted'
	const message = await insertEmailMessage({
		db,
		message: {
			id: 'msg-accepted',
			direction: 'outbound',
			userId,
			fromAddress: 'user@example.com',
			toAddresses: ['to@example.com'],
			subject: 'Accepted',
			processingStatus: 'stored',
		},
	})

	const providerMessageId = 'provider-accepted'
	const batchSpy = vi.spyOn(db, 'batch')
	await updateEmailMessageDelivery({
		db,
		messageId: message.id,
		status: 'sent',
		providerMessageId,
		error: null,
		sentAt: '2026-08-01T12:10:00.000Z',
	})
	expect(batchSpy).toHaveBeenCalledTimes(1)
	const batchStatements = batchSpy.mock.calls[0]?.[0] ?? []
	expect(batchStatements.length).toBeGreaterThan(1)

	const stored = await getEmailMessageById({
		db,
		userId,
		messageId: message.id,
	})
	expect(stored).toMatchObject({
		processingStatus: 'sent',
		providerMessageId,
		error: null,
	})
	expect(
		await getOutboundEmailMessageByProviderMessageId({
			db,
			providerMessageId,
		}),
	).toMatchObject({ id: message.id, userId })
	expect(
		(
			sqlite
				.prepare(
					`SELECT provider, user_id, message_id
					FROM email_outbound_provider_index
					WHERE provider_message_id = ?`,
				)
				.get(providerMessageId) as {
				provider: string
				user_id: string
				message_id: string
			} | null
		)?.provider,
	).toBe(emailOutboundProviderCloudflare)

	// A post-commit index-only failure cannot exist: sync statements were in the
	// same accepted batch as the authoritative status update.
	expect(stored?.processingStatus).not.toBe('failed')
})
