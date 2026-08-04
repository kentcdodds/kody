import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listPopularAgentPackagesForUser,
	recordAgentPackageConversationUse,
	recordAgentPackageConversationUses,
} from './agent-package-conversation-uses.ts'

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedPackage(
	sqlite: DatabaseSync,
	input: {
		id: string
		userId: string
		kodyId: string
		description: string
		name?: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.name ?? input.kodyId,
			input.kodyId,
			input.description,
			`source-${input.id}`,
		)
}

test('recordAgentPackageConversationUse upserts idempotently per conversation', async () => {
	const { sqlite, db } = createTestDb()
	seedPackage(sqlite, {
		id: 'pkg-1',
		userId: 'user-a',
		kodyId: 'mail',
		description: 'Mail helper',
	})

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

test('agent package popularity ranking fails open and ranks within last N conversations', async () => {
	consoleWarn.mockImplementation(() => {})
	const missingTableDb = createD1FromSqlite(new DatabaseSync(':memory:'))
	await expect(
		listPopularAgentPackagesForUser(missingTableDb, { userId: 'user-a' }),
	).resolves.toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'agent-package-conversation-use-list-failed',
		expect.anything(),
	)
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
	seedPackage(sqlite, {
		id: 'pkg-a',
		userId: 'user-a',
		kodyId: 'alpha',
		description: 'Alpha pack',
	})
	seedPackage(sqlite, {
		id: 'pkg-b',
		userId: 'user-a',
		kodyId: 'bravo',
		description: 'Bravo pack',
	})
	seedPackage(sqlite, {
		id: 'pkg-c',
		userId: 'user-a',
		kodyId: 'charlie',
		description: 'Charlie pack',
	})

	const now = new Date('2026-07-21T12:00:00.000Z')
	// Five conversations; ranking uses only the newest 4.
	// c1–c3: alpha; c1+c4: bravo; c0 (oldest): charlie only
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-c',
			conversationId: 'c0',
			usedAt: '2026-07-01T00:00:00.000Z',
		},
	)
	for (const [conversationId, usedAt] of [
		['c1', '2026-07-10T00:00:00.000Z'],
		['c2', '2026-07-11T00:00:00.000Z'],
		['c3', '2026-07-12T00:00:00.000Z'],
	] as const) {
		await recordAgentPackageConversationUse(
			{ APP_DB: db },
			{
				userId: 'user-a',
				packageId: 'pkg-a',
				conversationId,
				usedAt,
			},
		)
	}
	await recordAgentPackageConversationUses(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageIds: ['pkg-b', 'pkg-b'],
			conversationId: 'c1',
			usedAt: '2026-07-10T00:00:00.000Z',
		},
	)
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-b',
			conversationId: 'c4',
			usedAt: '2026-07-13T00:00:00.000Z',
		},
	)
	// deleted package row still in uses — skip via join
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-gone',
			conversationId: 'c5',
			usedAt: '2026-07-14T00:00:00.000Z',
		},
	)

	const ranked = await listPopularAgentPackagesForUser(db, {
		userId: 'user-a',
		now,
		conversationLimit: 4,
		limit: 8,
	})
	// Last 4 conversations by recency: c5 (gone), c4 (bravo), c3/c2/c1 (alpha),
	// but limit 4 means c5,c4,c3,c2 — charlie's c0 is excluded.
	expect(ranked.map((row) => row.kodyId)).toEqual(['alpha', 'bravo'])
	expect(ranked[0]?.conversationCount).toBe(2) // c2, c3
	expect(ranked[1]?.conversationCount).toBe(1) // c4
})

test('listPopularAgentPackagesForUser ignores max-age conversations and stale package rows inside recent ones', async () => {
	const { sqlite, db } = createTestDb()
	seedPackage(sqlite, {
		id: 'pkg-a',
		userId: 'user-a',
		kodyId: 'alpha',
		description: 'Alpha pack',
	})
	seedPackage(sqlite, {
		id: 'pkg-old',
		userId: 'user-a',
		kodyId: 'stale',
		description: 'Stale pack',
	})

	const now = new Date('2026-07-21T12:00:00.000Z')
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-old',
			conversationId: 'ancient',
			usedAt: '2025-01-01T00:00:00.000Z',
		},
	)
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-a',
			conversationId: 'recent',
			usedAt: '2026-07-10T00:00:00.000Z',
		},
	)
	// Same conversation: recent alpha use pulls the conversation into last-N,
	// but a much older stale-package row must not count.
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-old',
			conversationId: 'shared',
			usedAt: '2025-01-01T00:00:00.000Z',
		},
	)
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-a',
			conversationId: 'shared',
			usedAt: '2026-07-10T00:00:00.000Z',
		},
	)

	const ranked = await listPopularAgentPackagesForUser(db, {
		userId: 'user-a',
		now,
		conversationLimit: 40,
		maxAgeDays: 180,
	})
	expect(ranked.map((row) => row.kodyId)).toEqual(['alpha'])
	expect(ranked[0]?.conversationCount).toBe(2)
})
