import { expect, test } from 'vitest'
import {
	stampFirstExecute,
	stampFirstMcpConnected,
	stampFirstSavedPackage,
	stampFirstSearch,
} from './activation-stamps.ts'

function createUsersDb() {
	const columns = new Map<string, Record<string, unknown>>()

	const db = {
		prepare(sql: string) {
			return {
				bind(...values: Array<unknown>) {
					return {
						async run() {
							const stableUserId = String(values[values.length - 1])
							const row = columns.get(stableUserId) ?? {
								first_mcp_connected_at: null,
								first_execute_at: null,
								first_search_at: null,
								first_saved_package_at: null,
								mcp_client_name: null,
								last_active_at: null,
							}
							if (sql.includes('first_mcp_connected_at')) {
								const at = values[0]
								const clientName = values[1]
								if (row.first_mcp_connected_at == null) {
									row.first_mcp_connected_at = at
								}
								if (row.mcp_client_name == null && clientName != null) {
									row.mcp_client_name = clientName
								}
								row.last_active_at = at
							}
							if (sql.includes('first_execute_at')) {
								const at = values[0]
								if (row.first_execute_at == null) {
									row.first_execute_at = at
								}
								row.last_active_at = at
							}
							if (sql.includes('first_search_at')) {
								const at = values[0]
								if (row.first_search_at == null) {
									row.first_search_at = at
								}
								row.last_active_at = at
							}
							if (sql.includes('first_saved_package_at')) {
								const at = values[0]
								if (row.first_saved_package_at == null) {
									row.first_saved_package_at = at
								}
								row.last_active_at = at
							}
							columns.set(stableUserId, row)
							return { success: true, meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return {
		db,
		row(stableUserId: string) {
			return columns.get(stableUserId) ?? null
		},
	}
}

test('activation stamps are write-once and keep the first client name', async () => {
	const store = createUsersDb()
	const userId = 'a'.repeat(64)

	await stampFirstMcpConnected(store.db, {
		stableUserId: userId,
		clientName: 'claude-ai',
		at: '2026-08-27T10:00:00.000Z',
	})
	await stampFirstMcpConnected(store.db, {
		stableUserId: userId,
		clientName: 'cursor',
		at: '2026-08-28T10:00:00.000Z',
	})
	await stampFirstExecute(store.db, {
		stableUserId: userId,
		at: '2026-08-27T11:00:00.000Z',
	})
	await stampFirstExecute(store.db, {
		stableUserId: userId,
		at: '2026-08-28T11:00:00.000Z',
	})
	await stampFirstSearch(store.db, {
		stableUserId: userId,
		at: '2026-08-27T11:30:00.000Z',
	})
	await stampFirstSearch(store.db, {
		stableUserId: userId,
		at: '2026-08-28T11:30:00.000Z',
	})
	await stampFirstSavedPackage(store.db, {
		stableUserId: userId,
		at: '2026-08-27T12:00:00.000Z',
	})
	await stampFirstSavedPackage(store.db, {
		stableUserId: userId,
		at: '2026-08-28T12:00:00.000Z',
	})

	expect(store.row(userId)).toEqual({
		first_mcp_connected_at: '2026-08-27T10:00:00.000Z',
		mcp_client_name: 'claude-ai',
		first_execute_at: '2026-08-27T11:00:00.000Z',
		first_search_at: '2026-08-27T11:30:00.000Z',
		first_saved_package_at: '2026-08-27T12:00:00.000Z',
		last_active_at: '2026-08-28T12:00:00.000Z',
	})
})
