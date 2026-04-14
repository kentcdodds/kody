import { expect, test } from 'vitest'
import {
	deleteMemory,
	getMemory,
	searchMemoryRecords,
	surfaceRelevantMemories,
	upsertMemory,
	verifyMemoryCandidate,
} from './service.ts'
import {
	type McpMemoryConversationSuppressionRow,
	type McpMemoryRow,
} from './types.ts'

function createMemoryTestDb() {
	const memories = new Map<string, McpMemoryRow>()
	const suppressions = new Map<string, McpMemoryConversationSuppressionRow>()

	function suppressionKey(
		userId: string,
		conversationId: string,
		memoryId: string,
	) {
		return `${userId}:${conversationId}:${memoryId}`
	}

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.includes('from mcp_memories') &&
								normalizedQuery.includes('where user_id = ? and id = ?')
							) {
								const [userId, memoryId] = params as Array<string>
								const row = memories.get(memoryId)
								if (!row || row.user_id !== userId) return null
								return { ...row } as T
							}
							return null
						},
						async all<T>() {
							if (
								normalizedQuery.includes('from mcp_memories') &&
								normalizedQuery.includes('order by updated_at desc')
							) {
								const [userId, ...rest] = params as Array<string | number>
								const limit = Number(rest.at(-1) ?? 100)
								const statusParams = rest.slice(0, -1).filter((value) => {
									return typeof value === 'string'
								}) as Array<string>
								const rows = [...memories.values()]
									.filter((row) => row.user_id === userId)
									.filter((row) =>
										statusParams.length === 0
											? true
											: statusParams.includes(row.status),
									)
									.sort((left, right) =>
										right.updated_at.localeCompare(left.updated_at),
									)
									.slice(0, limit)
									.map((row) => ({ ...row }))
								return { results: rows as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.includes(
									'from mcp_memory_conversation_suppressions',
								)
							) {
								const [userId, conversationId, now] = params as Array<string>
								const rows = [...suppressions.values()]
									.filter((row) => row.user_id === userId)
									.filter((row) => row.conversation_id === conversationId)
									.filter((row) => row.expires_at > now)
									.map((row) => ({ ...row }))
								return { results: rows as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (normalizedQuery.startsWith('insert into mcp_memories')) {
								const [
									id,
									userId,
									category,
									status,
									subject,
									summary,
									details,
									tagsJson,
									sourceUrisJson,
									dedupeKey,
									createdAt,
									updatedAt,
									lastAccessedAt,
									deletedAt,
								] = params as Array<string | null>
								memories.set(String(id), {
									id: String(id),
									user_id: String(userId),
									category: category == null ? null : String(category),
									status: String(status) as McpMemoryRow['status'],
									subject: String(subject),
									summary: String(summary),
									details: String(details ?? ''),
									tags_json: String(tagsJson ?? '[]'),
									source_uris_json: String(sourceUrisJson ?? '[]'),
									dedupe_key: dedupeKey == null ? null : String(dedupeKey),
									created_at: String(createdAt),
									updated_at: String(updatedAt),
									last_accessed_at:
										lastAccessedAt == null ? null : String(lastAccessedAt),
									deleted_at: deletedAt == null ? null : String(deletedAt),
								})
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('update mcp_memories set')) {
								if (normalizedQuery.includes('where user_id = ? and id = ?')) {
									const [
										category,
										status,
										subject,
										summary,
										details,
										tagsJson,
										sourceUrisJson,
										dedupeKey,
										lastAccessedAt,
										deletedAt,
										updatedAt,
										userId,
										memoryId,
									] = params as Array<string | null>
									const existing = memories.get(String(memoryId))
									if (!existing || existing.user_id !== userId) {
										return { meta: { changes: 0 } }
									}
									memories.set(String(memoryId), {
										...existing,
										category: category == null ? null : String(category),
										status: String(status) as McpMemoryRow['status'],
										subject: String(subject),
										summary: String(summary),
										details: String(details ?? ''),
										tags_json: String(tagsJson ?? '[]'),
										source_uris_json: String(sourceUrisJson ?? '[]'),
										dedupe_key: dedupeKey == null ? null : String(dedupeKey),
										last_accessed_at:
											lastAccessedAt == null ? null : String(lastAccessedAt),
										deleted_at: deletedAt == null ? null : String(deletedAt),
										updated_at: String(updatedAt),
									})
									return { meta: { changes: 1 } }
								}
								if (
									normalizedQuery.includes(
										'set last_accessed_at = ?, updated_at = updated_at',
									)
								) {
									const [lastAccessedAt, userId, ...memoryIds] =
										params as Array<string>
									let changes = 0
									for (const memoryId of memoryIds) {
										const existing = memories.get(memoryId)
										if (!existing || existing.user_id !== userId) continue
										memories.set(memoryId, {
											...existing,
											last_accessed_at: lastAccessedAt,
										})
										changes += 1
									}
									return { meta: { changes } }
								}
							}
							if (normalizedQuery.startsWith('delete from mcp_memories')) {
								const [userId, memoryId] = params as Array<string>
								const existing = memories.get(memoryId)
								if (!existing || existing.user_id !== userId) {
									return { meta: { changes: 0 } }
								}
								memories.delete(memoryId)
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'insert into mcp_memory_conversation_suppressions',
								)
							) {
								const [
									userId,
									conversationId,
									memoryId,
									createdAt,
									lastSeenAt,
									expiresAt,
								] = params as Array<string>
								suppressions.set(
									suppressionKey(userId, conversationId, memoryId),
									{
										user_id: userId,
										conversation_id: conversationId,
										memory_id: memoryId,
										created_at: createdAt,
										last_seen_at: lastSeenAt,
										expires_at: expiresAt,
									},
								)
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'delete from mcp_memory_conversation_suppressions',
								)
							) {
								if (normalizedQuery.includes('where expires_at <= ?')) {
									const [cutoff] = params as Array<string>
									let changes = 0
									for (const [key, row] of suppressions.entries()) {
										if (row.expires_at <= cutoff) {
											suppressions.delete(key)
											changes += 1
										}
									}
									return { meta: { changes } }
								}
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, memories, suppressions }
}

const env = (db: D1Database) =>
	({
		APP_DB: db,
	}) satisfies Pick<Env, 'APP_DB'> as Pick<Env, 'APP_DB' | 'AI'>

test('memory service upserts, verifies, and soft deletes', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)

	const created = await upsertMemory({
		env: runtimeEnv,
		userId: 'user-123',
		subject: 'Preferred editor theme',
		summary: 'User prefers a dark theme in editors.',
		details: 'Applies to code editors and dashboards.',
		category: 'preference',
		tags: ['theme', 'dark-mode'],
		sourceUris: ['https://docs.example.com/preferences/editor-theme'],
		verificationReference: 'verify-1',
	})

	expect(created.mode).toBe('created')
	expect(created.memory.subject).toBe('Preferred editor theme')
	expect(created.memory.sourceUris).toEqual([
		'https://docs.example.com/preferences/editor-theme',
	])

	const verify = await verifyMemoryCandidate({
		env: runtimeEnv,
		userId: 'user-123',
		candidate: {
			subject: 'Editor theme preference',
			summary: 'User likes dark mode in editing interfaces.',
			category: 'preference',
			tags: ['theme'],
			sourceUris: ['https://docs.example.com/preferences/editor-theme'],
		},
	})

	expect(verify.relatedMemories).toHaveLength(1)
	expect(verify.relatedMemories[0]?.memory.id).toBe(created.memory.id)
	expect(verify.candidate.source_uris).toEqual([
		'https://docs.example.com/preferences/editor-theme',
	])
	expect(verify.relatedMemories[0]?.memory.sourceUris).toEqual([
		'https://docs.example.com/preferences/editor-theme',
	])

	const updated = await upsertMemory({
		env: runtimeEnv,
		userId: 'user-123',
		memoryId: created.memory.id,
		subject: 'Preferred editor theme',
		summary: 'User prefers dark mode everywhere.',
		category: 'preference',
		tags: ['theme', 'dark-mode'],
		sourceUris: [
			'https://docs.example.com/preferences/editor-theme',
			'https://github.com/kentcdodds/kody/blob/main/docs/use/memory.md',
		],
		verificationReference: 'verify-2',
	})

	expect(updated.mode).toBe('updated')
	expect(updated.memory.summary).toBe('User prefers dark mode everywhere.')
	expect(updated.memory.sourceUris).toEqual([
		'https://docs.example.com/preferences/editor-theme',
		'https://github.com/kentcdodds/kody/blob/main/docs/use/memory.md',
	])

	const deleted = await deleteMemory({
		env: runtimeEnv,
		userId: 'user-123',
		memoryId: created.memory.id,
		force: false,
	})

	expect(deleted?.status).toBe('deleted')

	const loaded = await getMemory({
		env: { APP_DB: testDb.db },
		userId: 'user-123',
		memoryId: created.memory.id,
	})
	expect(loaded?.status).toBe('deleted')
	expect(loaded?.sourceUris).toEqual([
		'https://docs.example.com/preferences/editor-theme',
		'https://github.com/kentcdodds/kody/blob/main/docs/use/memory.md',
	])
})

test('memory surfacing suppresses repeated memories per conversation', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)

	await upsertMemory({
		env: runtimeEnv,
		userId: 'user-123',
		subject: 'Deployment window',
		summary: 'User prefers deployments after 4pm.',
		category: 'workflow',
		verificationReference: 'verify-3',
	})

	const first = await surfaceRelevantMemories({
		env: runtimeEnv,
		userId: 'user-123',
		query: 'deployment preference after 4pm',
		conversationId: 'conv-123',
	})

	expect(first.memories).toHaveLength(1)
	expect(first.suppressedCount).toBe(0)

	const second = await surfaceRelevantMemories({
		env: runtimeEnv,
		userId: 'user-123',
		query: 'deployment preference after 4pm',
		conversationId: 'conv-123',
	})

	expect(second.memories).toHaveLength(0)
	expect(second.suppressedCount).toBeGreaterThanOrEqual(1)

	const search = await searchMemoryRecords({
		env: runtimeEnv,
		userId: 'user-123',
		query: 'deployment preference after 4pm',
		conversationId: 'conv-123',
	})

	expect(search.matches).toHaveLength(0)
	expect(search.suppressedCount).toBeGreaterThanOrEqual(1)
})

test('memory service rejects invalid source uris and tolerates missing stored values', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)

	await expect(
		upsertMemory({
			env: runtimeEnv,
			userId: 'user-123',
			subject: 'Invalid source URIs',
			summary: 'This write should fail validation.',
			sourceUris: ['not-a-url'],
			verificationReference: 'verify-4',
		}),
	).rejects.toThrow('Memory source_uris entries must be valid URLs.')

	testDb.memories.set('legacy-memory', {
		id: 'legacy-memory',
		user_id: 'user-123',
		category: 'profile',
		status: 'active',
		subject: 'Legacy memory',
		summary: 'Stored before source URIs existed.',
		details: '',
		tags_json: '["legacy"]',
		dedupe_key: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		last_accessed_at: null,
		deleted_at: null,
	} as unknown as McpMemoryRow)

	const loaded = await getMemory({
		env: { APP_DB: testDb.db },
		userId: 'user-123',
		memoryId: 'legacy-memory',
	})

	expect(loaded?.sourceUris).toEqual([])
})
