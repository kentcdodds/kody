import { expect, test } from 'vitest'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#mcp/capabilities/capability-search.ts'
import {
	acknowledgeSurfacedMemories,
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
	const batches: Array<Array<unknown>> = []

	function suppressionKey(
		userId: string,
		conversationId: string,
		memoryId: string,
	) {
		return `${userId}:${conversationId}:${memoryId}`
	}

	const db = {
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			batches.push(statements)
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.startsWith(
									'select 1 as held from account_write_leases',
								)
							) {
								return { held: 1 } as T
							}
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
								normalizedQuery.includes('and id in (')
							) {
								const [userId, ...rest] = params as Array<string>
								const statusValues = new Set(['active', 'archived', 'deleted'])
								const ids = rest.filter((value) => !statusValues.has(value))
								const statuses = rest.filter((value) => statusValues.has(value))
								const rows = [...memories.values()]
									.filter((row) => row.user_id === userId)
									.filter((row) => ids.includes(row.id))
									.filter((row) =>
										statuses.length === 0
											? true
											: statuses.includes(row.status),
									)
									.map((row) => ({ ...row }))
								return { results: rows as Array<T>, meta: { changes: 0 } }
							}
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
							if (
								normalizedQuery.startsWith(
									'insert into account_write_leases',
								) ||
								normalizedQuery.startsWith('update account_write_leases')
							) {
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('update users')) {
								return { meta: { changes: 1 } }
							}
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

	return { db, memories, suppressions, batches }
}

const env = (db: D1Database) =>
	({
		APP_DB: db,
	}) satisfies Pick<Env, 'APP_DB'> as Pick<Env, 'APP_DB' | 'AI'>

function createDeterministicAiBinding(): Ai {
	return {
		async run(...args: Array<unknown>) {
			const input = args[1] as { text?: unknown }
			const texts = Array.isArray(input.text)
				? input.text.map(String)
				: [String(input.text ?? '')]
			return {
				data: texts.map((text) => deterministicEmbedding(text)),
				shape: [texts.length, CAPABILITY_EMBEDDING_DIMENSIONS],
			}
		},
	} as unknown as Ai
}

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

test('memory search returns mutable user-owned ids that can be updated and deleted', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)

	await upsertMemory({
		env: runtimeEnv,
		userId: 'user-123',
		subject: 'Mutable memory id',
		summary: 'Search results should return ids that mutation calls can reuse.',
		category: 'workflow',
		verificationReference: 'verify-3',
	})
	await upsertMemory({
		env: runtimeEnv,
		userId: 'other-user',
		subject: 'Mutable memory id',
		summary: 'This other-user memory must not leak through search.',
		category: 'workflow',
		verificationReference: 'verify-4',
	})

	const search = await searchMemoryRecords({
		env: runtimeEnv,
		userId: 'user-123',
		query: 'mutable memory id mutation calls',
	})

	expect(search.matches).toHaveLength(1)
	const match = search.matches[0]!
	expect(match.subject).toBe('Mutable memory id')

	const updated = await upsertMemory({
		env: runtimeEnv,
		userId: 'user-123',
		memoryId: match.id,
		subject: 'Mutable memory id',
		summary: 'The exact search result id was accepted by upsert.',
		category: 'workflow',
		verificationReference: 'verify-5',
	})
	expect(updated.mode).toBe('updated')
	expect(updated.memory.id).toBe(match.id)

	const deleted = await deleteMemory({
		env: runtimeEnv,
		userId: 'user-123',
		memoryId: match.id,
	})
	expect(deleted?.id).toBe(match.id)
	expect(deleted?.status).toBe('deleted')
})

test('memory upsert rejects unknown mutation ids', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)

	await expect(
		upsertMemory({
			env: runtimeEnv,
			userId: 'user-123',
			memoryId: 'transcribed-memory-id',
			subject: 'Preferred editor theme',
			summary: 'User prefers a dark theme in editors.',
			category: 'preference',
			verificationReference: 'verify-6',
		}),
	).rejects.toThrow(
		'Memory "transcribed-memory-id" was not found in mutable memory storage for this signed-in user.',
	)
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

test('acknowledgeSurfacedMemories writes suppressions and last_accessed in one batch', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)
	const created = await upsertMemory({
		env: runtimeEnv,
		userId: 'user-123',
		subject: 'Ack batch',
		summary: 'Atomic acknowledgement coverage.',
		category: 'workflow',
		verificationReference: 'verify-ack-batch',
	})
	testDb.batches.length = 0

	await acknowledgeSurfacedMemories({
		env: runtimeEnv,
		userId: 'user-123',
		conversationId: 'conv-ack-batch',
		memoryIds: [created.memory.id],
	})

	expect(testDb.batches).toHaveLength(1)
	expect(testDb.batches[0]).toHaveLength(2)
	expect(
		testDb.suppressions.get(`user-123:conv-ack-batch:${created.memory.id}`),
	).toMatchObject({
		memory_id: created.memory.id,
		conversation_id: 'conv-ack-batch',
	})
	expect(testDb.memories.get(created.memory.id)?.last_accessed_at).toEqual(
		expect.any(String),
	)
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

test('memory search online queries Vectorize first and hydrates vector hits by id', async () => {
	const testDb = createMemoryTestDb()
	const baseTime = Date.parse('2026-06-01T00:00:00.000Z')
	function seedMemory(input: {
		id: string
		subject: string
		summary: string
		ageMinutes: number
	}) {
		const timestamp = new Date(
			baseTime - input.ageMinutes * 60_000,
		).toISOString()
		testDb.memories.set(input.id, {
			id: input.id,
			user_id: 'user-123',
			category: null,
			status: 'active',
			subject: input.subject,
			summary: input.summary,
			details: '',
			tags_json: '[]',
			source_uris_json: '[]',
			dedupe_key: null,
			created_at: timestamp,
			updated_at: timestamp,
			last_accessed_at: null,
			deleted_at: null,
		})
	}
	seedMemory({
		id: 'memory-recent',
		subject: 'Deployment window',
		summary: 'User prefers deployments after 4pm.',
		ageMinutes: 0,
	})
	// Enough newer filler rows that the old memory falls outside the bounded
	// lexical candidate set (most recent 50 rows).
	for (let index = 0; index < 60; index += 1) {
		seedMemory({
			id: `filler-${index}`,
			subject: `Filler note ${index}`,
			summary: 'Unrelated grocery reminder.',
			ageMinutes: index + 1,
		})
	}
	seedMemory({
		id: 'memory-old-vector-hit',
		subject: 'Deployment window history',
		summary: 'Old deployment window memory only reachable via Vectorize.',
		ageMinutes: 10_000,
	})

	const vectorQueryCalls: Array<{
		topK: number
		filter?: Record<string, unknown>
	}> = []
	const runtimeEnv = {
		APP_DB: testDb.db,
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: {
			async query(
				_values: Array<number>,
				options: { topK: number; filter?: Record<string, unknown> },
			) {
				vectorQueryCalls.push(options)
				return {
					matches: [{ id: 'memory_memory-old-vector-hit', score: 0.92 }],
				}
			},
		},
	} as unknown as Pick<Env, 'APP_DB' | 'CAPABILITY_VECTOR_INDEX'>

	const result = await searchMemoryRecords({
		env: runtimeEnv,
		userId: 'user-123',
		query: 'deployment window',
		limit: 5,
	})

	// One Vectorize query with user/kind/status metadata filters; no second
	// query happens inside the fusion step.
	expect(vectorQueryCalls).toHaveLength(1)
	expect(vectorQueryCalls[0]).toMatchObject({
		filter: {
			kind: { $eq: 'memory' },
			userId: { $eq: 'user-123' },
			status: { $in: ['active', 'archived'] },
		},
	})
	const matchedIds = result.matches.map((match) => match.id)
	expect(matchedIds).toContain('memory-old-vector-hit')
	expect(matchedIds).toContain('memory-recent')
})
