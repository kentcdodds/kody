import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listMcpAgentSessionsForUser,
	registerMcpAgentSession,
} from './session-registry.ts'

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
})
