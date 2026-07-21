import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	listPopularAgentPackagesForUser,
	recordAgentPackageConversationUse,
	recordAgentPackageConversationUses,
} from './agent-package-conversation-uses.ts'

type TestD1Statement = {
	bind(...params: Array<unknown>): TestD1Statement
	all<T>(): Promise<{ results: Array<T>; meta: { changes: number } }>
	first<T>(): Promise<T | null>
	run(): Promise<{ meta: { changes: number } }>
}

function createD1FromSqlite(sqlite: DatabaseSync) {
	function createStatement(
		query: string,
		params: Array<unknown> = [],
	): TestD1Statement {
		return {
			bind(...boundParams: Array<unknown>) {
				return createStatement(query, boundParams)
			},
			async all<T>() {
				return {
					results: sqlite.prepare(query).all(...params) as Array<T>,
					meta: { changes: 0 },
				}
			},
			async first<T>() {
				return (sqlite.prepare(query).get(...params) ?? null) as T | null
			},
			async run() {
				const result = sqlite.prepare(query).run(...params)
				return { meta: { changes: result.changes } }
			},
		}
	}
	return {
		prepare(query: string) {
			return createStatement(query)
		},
	} as unknown as D1Database
}

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL('../../migrations/0027-saved-packages.sql', import.meta.url),
			'utf8',
		),
	)
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0073-agent-package-conversation-uses.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
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

test('listPopularAgentPackagesForUser returns [] when the table is missing', async () => {
	consoleWarn.mockImplementation(() => {})
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await expect(
		listPopularAgentPackagesForUser(db, { userId: 'user-a' }),
	).resolves.toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'agent-package-conversation-use-list-failed',
		expect.anything(),
	)
})

test('listPopularAgentPackagesForUser ranks by distinct conversations and skips missing packages', async () => {
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
	const recent = '2026-07-10T00:00:00.000Z'
	const older = '2026-06-01T00:00:00.000Z'

	// alpha: 3 conversations
	for (const conversationId of ['c1', 'c2', 'c3']) {
		await recordAgentPackageConversationUse(
			{ APP_DB: db },
			{
				userId: 'user-a',
				packageId: 'pkg-a',
				conversationId,
				usedAt: recent,
			},
		)
	}
	// bravo: 2 conversations (one duplicate upsert)
	await recordAgentPackageConversationUses(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageIds: ['pkg-b', 'pkg-b'],
			conversationId: 'c1',
			usedAt: recent,
		},
	)
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-b',
			conversationId: 'c4',
			usedAt: recent,
		},
	)
	// charlie: only outside the window
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-c',
			conversationId: 'c-old',
			usedAt: older,
		},
	)
	// deleted package row still in uses — skip via join
	await recordAgentPackageConversationUse(
		{ APP_DB: db },
		{
			userId: 'user-a',
			packageId: 'pkg-gone',
			conversationId: 'c5',
			usedAt: recent,
		},
	)

	const ranked = await listPopularAgentPackagesForUser(db, {
		userId: 'user-a',
		now,
		limit: 8,
	})
	expect(ranked.map((row) => row.kodyId)).toEqual(['alpha', 'bravo'])
	expect(ranked[0]?.conversationCount).toBe(3)
	expect(ranked[1]?.conversationCount).toBe(2)
})

test('recordAgentPackageConversationUse never throws when DB is missing', async () => {
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
})
