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
								first_secret_at: null,
								first_integration_at: null,
								first_job_at: null,
								mcp_client_name: null,
								last_active_at: null,
							}
							let changes = 0
							const touchLastActive = (at: unknown) => {
								const next = String(at)
								if (
									row.last_active_at == null ||
									String(row.last_active_at) < next
								) {
									row.last_active_at = at
								}
							}
							if (sql.includes('first_mcp_connected_at')) {
								const at = values[0]
								const clientName = values[1]
								if (row.first_mcp_connected_at == null) {
									row.first_mcp_connected_at = at
									changes = 1
								}
								if (row.mcp_client_name == null && clientName != null) {
									row.mcp_client_name = clientName
									changes = 1
								}
								touchLastActive(at)
							}
							const claimColumns = [
								'first_execute_at',
								'first_search_at',
								'first_saved_package_at',
								'first_secret_at',
								'first_integration_at',
								'first_job_at',
							] as const
							for (const column of claimColumns) {
								if (!sql.includes(`SET ${column} =`)) continue
								const at = values[0]
								if (row[column] == null) {
									row[column] = at
									touchLastActive(at)
									changes = 1
								}
							}
							if (
								changes === 0 &&
								sql.includes('SET last_active_at =') &&
								!claimColumns.some((column) => sql.includes(`SET ${column} =`))
							) {
								touchLastActive(values[0])
								changes = 1
							}
							columns.set(stableUserId, row)
							return { success: true, meta: { changes } }
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
		first_secret_at: null,
		first_integration_at: null,
		first_job_at: null,
		last_active_at: '2026-08-28T12:00:00.000Z',
	})
})
