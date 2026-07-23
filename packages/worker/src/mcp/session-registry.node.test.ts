import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listMcpAgentSessionsForUser,
	purgePersistedMcpAgentSession,
	readPersistedMcpAgentOwner,
	registerMcpAgentSession,
} from './session-registry.ts'
import { createMcpCallerContext } from './context.ts'

test('MCP agent session registry is idempotent and user scoped', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE mcp_agent_sessions (
			do_id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
	`)
	const db = createD1FromSqlite(sqlite)
	await registerMcpAgentSession({
		db,
		userId: 'user-a',
		doId: 'do-a',
	})
	await registerMcpAgentSession({
		db,
		userId: 'user-a',
		doId: 'do-a',
	})
	await registerMcpAgentSession({
		db,
		userId: 'user-b',
		doId: 'do-b',
	})
	await expect(listMcpAgentSessionsForUser(db, 'user-a')).resolves.toEqual([
		{ doId: 'do-a' },
	])
	await expect(listMcpAgentSessionsForUser(db, 'user-b')).resolves.toEqual([
		{ doId: 'do-b' },
	])
	await expect(
		registerMcpAgentSession({
			db,
			userId: 'user-b',
			doId: 'do-a',
		}),
	).rejects.toThrow('ownership conflict')
	await expect(listMcpAgentSessionsForUser(db, 'user-a')).resolves.toEqual([
		{ doId: 'do-a' },
	])
})

test('cold MCP session owner discovery reads persisted Agents SDK props', async () => {
	const props = createMcpCallerContext({
		baseUrl: 'https://example.com',
		executionOrigin: 'interactive',
		user: {
			userId: 'user-a',
			email: 'a@example.com',
			displayName: 'User A',
		},
	})
	const storage = {
		async get<T>(key: string) {
			expect(key).toBe('props')
			return props as T
		},
	}
	await expect(
		readPersistedMcpAgentOwner({
			storage,
			doId: 'cold-do',
		}),
	).resolves.toEqual({ doId: 'cold-do', userId: 'user-a' })
	let purged = false
	await purgePersistedMcpAgentSession({
		storage: {
			...storage,
			async deleteAll() {
				purged = true
			},
		},
		doId: 'cold-do',
		userId: 'user-a',
	})
	expect(purged).toBe(true)
})
