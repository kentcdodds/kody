import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { d1LockRetryBaseDelayMs } from '#worker/d1-retry.ts'
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

test('registerMcpAgentSession retries a transient D1 internal error with an underscored reference', async () => {
	let attempts = 0
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							attempts += 1
							if (attempts === 1) {
								throw new Error(
									'D1_ERROR: internal error; reference = e_Gz3hrU_5c47162d21d24e238a5c25e98b89ee39',
								)
							}
						},
						async first() {
							return { owned: 1 }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	vi.useFakeTimers()
	try {
		const resultPromise = registerMcpAgentSession({
			db,
			userId: 'user-a',
			doId: 'do-a',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBeUndefined()
		expect(attempts).toBe(2)
	} finally {
		vi.useRealTimers()
	}
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
