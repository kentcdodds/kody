import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	applyMigrationLikeD1,
	applyMigrationsBefore,
} from '#worker/test-support/system-email-graph-migration.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	emailOutboundProviderCloudflare,
	getOutboundProviderIndexRow,
} from './outbound-provider-index.ts'

const providerIndexDetachMigration =
	'0132-email-outbound-provider-index-detach.sql'

function tableColumns(db: DatabaseSync) {
	return db.prepare(`PRAGMA table_info(email_outbound_provider_index)`).all()
}

function namedIndexes(db: DatabaseSync) {
	return db
		.prepare(
			`SELECT name, "unique"
			FROM pragma_index_list('email_outbound_provider_index')
			WHERE origin != 'pk'
			ORDER BY name`,
		)
		.all()
}

function compatibilityTrigger(db: DatabaseSync) {
	return db
		.prepare(
			`SELECT sql
			FROM sqlite_schema
			WHERE type = 'trigger'
				AND name = 'email_messages_delete_outbound_provider_index'`,
		)
		.get()
}

test('0132 detaches the FK while preserving rollback message-delete behavior', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	applyMigrationsBefore(sqlite, providerIndexDetachMigration)
	sqlite.exec(`
		INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			provider_message_id, created_at, updated_at
		) VALUES
			(
				'user-message-1', 'outbound', 'user-1', 'sender@example.com',
				'sent', 'provider-user-1', '2026-08-03T00:00:00.000Z',
				'2026-08-03T00:01:00.000Z'
			),
			(
				'user-message-2', 'outbound', 'user-2', 'sender@example.com',
				'sent', 'provider-user-2', '2026-08-03T00:02:00.000Z',
				'2026-08-03T00:03:00.000Z'
			),
			(
				'system-message', 'inbound', '${systemEmailOwnerId}',
				'sender@example.net', 'stored', NULL,
				'2026-08-03T00:04:00.000Z', '2026-08-03T00:05:00.000Z'
			);

		INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, inbox_id,
			created_at, updated_at
		) VALUES
			(
				'${emailOutboundProviderCloudflare}', 'provider-user-1', 'user-1',
				'user-message-1', 'inbox-1', '2026-08-03T00:00:00.000Z',
				'2026-08-03T00:01:00.000Z'
			),
			(
				'${emailOutboundProviderCloudflare}', 'provider-user-2', 'user-2',
				'user-message-2', NULL, '2026-08-03T00:02:00.000Z',
				'2026-08-03T00:03:00.000Z'
			),
			(
				'${emailOutboundProviderCloudflare}', 'invalid-system-provider',
				'${systemEmailOwnerId}', 'system-message', NULL,
				'2026-08-03T00:04:00.000Z', '2026-08-03T00:05:00.000Z'
			);
	`)
	const columnsBefore = tableColumns(sqlite)
	const indexesBefore = namedIndexes(sqlite)

	expect(() =>
		applyMigrationLikeD1(sqlite, providerIndexDetachMigration),
	).toThrow(/CHECK constraint failed/u)
	expect(tableColumns(sqlite)).toEqual(columnsBefore)
	expect(namedIndexes(sqlite)).toEqual(indexesBefore)
	expect(
		sqlite
			.prepare(`PRAGMA foreign_key_list(email_outbound_provider_index)`)
			.all(),
	).toContainEqual(
		expect.objectContaining({
			table: 'email_messages',
			from: 'message_id',
			to: 'id',
			on_delete: 'CASCADE',
		}),
	)
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				FROM email_outbound_provider_index`,
			)
			.get(),
	).toEqual({ count: 3 })
	expect(compatibilityTrigger(sqlite)).toBeUndefined()

	sqlite
		.prepare(
			`DELETE FROM email_outbound_provider_index
			WHERE user_id = ?`,
		)
		.run(systemEmailOwnerId)
	applyMigrationLikeD1(sqlite, providerIndexDetachMigration)

	expect(tableColumns(sqlite)).toEqual(columnsBefore)
	expect(namedIndexes(sqlite)).toEqual(indexesBefore)
	expect(
		sqlite
			.prepare(`PRAGMA foreign_key_list(email_outbound_provider_index)`)
			.all(),
	).toEqual([])
	expect(compatibilityTrigger(sqlite)).toEqual({
		sql: expect.stringContaining('DELETE FROM email_outbound_provider_index'),
	})
	expect(
		sqlite
			.prepare(
				`SELECT
					provider, provider_message_id, user_id, message_id, inbox_id,
					created_at, updated_at
				FROM email_outbound_provider_index
				ORDER BY provider_message_id`,
			)
			.all(),
	).toEqual([
		{
			provider: emailOutboundProviderCloudflare,
			provider_message_id: 'provider-user-1',
			user_id: 'user-1',
			message_id: 'user-message-1',
			inbox_id: 'inbox-1',
			created_at: '2026-08-03T00:00:00.000Z',
			updated_at: '2026-08-03T00:01:00.000Z',
		},
		{
			provider: emailOutboundProviderCloudflare,
			provider_message_id: 'provider-user-2',
			user_id: 'user-2',
			message_id: 'user-message-2',
			inbox_id: null,
			created_at: '2026-08-03T00:02:00.000Z',
			updated_at: '2026-08-03T00:03:00.000Z',
		},
	])
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				FROM email_outbound_provider_index
				WHERE user_id = ?`,
			)
			.get(systemEmailOwnerId),
	).toEqual({ count: 0 })
	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO email_outbound_provider_index (
					provider, provider_message_id, user_id, message_id,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				emailOutboundProviderCloudflare,
				'provider-system-after-cutover',
				systemEmailOwnerId,
				'system-message',
				'2026-08-03T00:06:00.000Z',
				'2026-08-03T00:06:00.000Z',
			),
	).toThrow(/CHECK constraint failed/u)

	const d1 = createD1FromSqlite(sqlite)
	await expect(
		getOutboundProviderIndexRow({
			db: d1,
			providerMessageId: 'provider-user-1',
		}),
	).resolves.toMatchObject({
		userId: 'user-1',
		messageId: 'user-message-1',
		inboxId: 'inbox-1',
	})

	// This is the old rollback path: one legacy message DELETE, with no app
	// provider-index statement. The schema trigger preserves FK-cascade behavior.
	sqlite
		.prepare(`DELETE FROM email_messages WHERE id = ?`)
		.run('user-message-1')
	await expect(
		getOutboundProviderIndexRow({
			db: d1,
			providerMessageId: 'provider-user-1',
		}),
	).resolves.toBeNull()

	const cleanup = sqlite
		.prepare(
			`DELETE FROM email_outbound_provider_index
			WHERE user_id = ?`,
		)
		.run('user-2')
	expect(cleanup.changes).toBe(1)
	expect(
		sqlite
			.prepare(
				`SELECT provider_message_id
				FROM email_outbound_provider_index
				ORDER BY provider_message_id`,
			)
			.all(),
	).toEqual([])
	expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
