import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	recordAgentPackageConversationUse,
	recordAgentPackageConversationUses,
} from './agent-package-conversation-uses.ts'

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedPackages(
	sqlite: DatabaseSync,
	packages: Array<[id: string, kodyId: string, description: string]>,
) {
	for (const [id, kodyId, description] of packages) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, source_id
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, 'user-a', kodyId, kodyId, description, `source-${id}`)
	}
}

test('recordAgentPackageConversationUse upserts idempotently per conversation', async () => {
	const { sqlite, db } = createTestDb()
	seedPackages(sqlite, [['pkg-1', 'mail', 'Mail helper']])
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-1',
			conversationId: 'conv-1',
			usedAt: '2026-07-01T10:00:00.000Z',
		},
	)
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-1',
			conversationId: 'conv-1',
			usedAt: '2026-07-01T12:00:00.000Z',
		},
	)

	const rows = sqlite
		.prepare(
			`SELECT user_id, package_id, conversation_id, first_used_at, last_used_at
			FROM agent_package_conversation_uses`,
		)
		.all() as Array<{
		user_id: string
		package_id: string
		conversation_id: string
		first_used_at: string
		last_used_at: string
	}>
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({
		user_id: 'user-a',
		package_id: 'pkg-1',
		first_used_at: '2026-07-01T10:00:00.000Z',
		last_used_at: '2026-07-01T12:00:00.000Z',
	})
	// Stored value is a SHA-256 hex digest, not the raw conversation id.
	expect(rows[0]?.conversation_id).toMatch(/^[0-9a-f]{64}$/)
	expect(rows[0]?.conversation_id).not.toBe('conv-1')
})

test('recordAgentPackageConversationUses batches distinct package ids and skips missing APP_DB', async () => {
	await expect(
		recordAgentPackageConversationUse(
			{},
			{
				userId: 'user-a',
				packageId: 'pkg-1',
				conversationId: 'conv-1',
			},
		),
	).resolves.toBeUndefined()

	const { sqlite, db } = createTestDb()
	seedPackages(sqlite, [
		['pkg-a', 'alpha', 'Alpha pack'],
		['pkg-b', 'bravo', 'Bravo pack'],
	])
	await recordAgentPackageConversationUses(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageIds: ['pkg-a', 'pkg-a', 'pkg-b'],
			conversationId: 'c1',
			usedAt: '2026-07-10T00:00:00.000Z',
		},
	)

	const rows = sqlite
		.prepare(
			`SELECT package_id FROM agent_package_conversation_uses
			ORDER BY package_id ASC`,
		)
		.all() as Array<{ package_id: string }>
	expect(rows.map((row) => row.package_id)).toEqual(['pkg-a', 'pkg-b'])
})
