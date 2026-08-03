import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	getOutboundProviderIndexRow,
	upsertOutboundProviderIndexRow,
} from './outbound-provider-index.ts'

test('thin provider index persists independently without a shared message graph table', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE email_outbound_provider_index (
			provider TEXT NOT NULL,
			provider_message_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			inbox_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (provider, provider_message_id)
		);
	`)
	const db = createD1FromSqlite(sqlite)

	await upsertOutboundProviderIndexRow({
		db,
		providerMessageId: 'provider-1',
		userId: 'user-1',
		messageId: 'message-1',
		inboxId: 'inbox-1',
		now: '2026-08-03T00:00:00.000Z',
	})
	await upsertOutboundProviderIndexRow({
		db,
		providerMessageId: 'provider-1',
		userId: 'user-1',
		messageId: 'message-1',
		inboxId: 'inbox-2',
		now: '2026-08-03T00:01:00.000Z',
	})

	await expect(
		getOutboundProviderIndexRow({
			db,
			providerMessageId: 'provider-1',
		}),
	).resolves.toEqual({
		provider: 'cloudflare-email',
		providerMessageId: 'provider-1',
		userId: 'user-1',
		messageId: 'message-1',
		inboxId: 'inbox-2',
		createdAt: '2026-08-03T00:00:00.000Z',
		updatedAt: '2026-08-03T00:01:00.000Z',
	})
	sqlite.close()
})
