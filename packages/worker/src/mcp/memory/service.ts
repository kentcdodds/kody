import { type StorageContext } from '#mcp/storage.ts'
import {
	deleteMemory as deleteMemoryRow,
	getConversationSuppressions,
	getMemoryById,
	insertMemory,
	listMemoriesByUserId,
	pruneExpiredConversationSuppressions,
	touchMemoryAccessedAt,
	updateMemory,
	upsertConversationSuppressions,
} from './repo.ts'
import { buildMemoryEmbedText } from './memory-embed.ts'
import { deleteMemoryVector, upsertMemoryVector } from './memory-vectorize.ts'
import { searchMemories } from './memory-search.ts'
import {
	type McpMemoryRow,
	type MemoryRecord,
	type MemorySearchMatch,
} from './types.ts'

const maxSubjectLength = 200
const maxSummaryLength = 500
const maxDetailsLength = 2_000
const maxCategoryLength = 80
const maxDedupeKeyLength = 160
const maxTagLength = 80
const maxTagCount = 16
const maxSourceUriLength = 2_048
const maxSourceUriCount = 12
const defaultSuppressionTtlMs = 30 * 24 * 60 * 60 * 1_000

function logMemoryVectorSyncError(input: {
	operation: 'upsert' | 'delete'
	memoryId: string
	userId: string
	category: string | null
	error: unknown
}) {
	console.warn('memory-vector-sync-failed', {
		operation: input.operation,
		memoryId: input.memoryId,
		userId: input.userId,
		category: input.category,
		error:
			input.error instanceof Error ? input.error.message : String(input.error),
	})
}

type MemoryOwnerContext = {
	userId: string
	storageContext?: StorageContext | null
}

type MemoryEnv = Pick<Env, 'APP_DB' | 'AI'> &
	Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>

type MemoryUpsertInput = MemoryOwnerContext & {
	env: MemoryEnv
	memoryId?: string | null
	category?: string | null
	subject: string
	summary: string
	details?: string | null
	tags?: Array<string> | null
	sourceUris?: Array<string> | null
	dedupeKey?: string | null
	status?: 'active' | 'archived'
	verificationReference?: string | null
}

type MemoryDeleteInput = MemoryOwnerContext & {
	env: MemoryEnv
	memoryId: string
	force?: boolean
}

type MemoryGetInput = MemoryOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	memoryId: string
}

type MemorySearchInput = MemoryOwnerContext & {
	env: MemoryEnv
	query: string
	category?: string | null
	limit?: number
	includeDeleted?: boolean
	conversationId?: string | null
	includeSuppressedInConversation?: boolean
}

type MemoryVerifyInput = MemoryOwnerContext & {
	env: MemoryEnv
	candidate: {
		subject: string
		summary: string
		details?: string | null
		category?: string | null
		tags?: Array<string> | null
		sourceUris?: Array<string> | null
		dedupeKey?: string | null
	}
	limit?: number
	conversationId?: string | null
	includeSuppressedInConversation?: boolean
}

type SurfaceRelevantMemoriesInput = MemoryOwnerContext & {
	env: MemoryEnv
	query: string
	conversationId: string
	limit?: number
}

export async function upsertMemory(input: MemoryUpsertInput): Promise<{
	mode: 'created' | 'updated'
	memory: MemoryRecord
	warnings: Array<string>
}> {
	const normalized = normalizeMemoryPayload(input)
	const now = new Date().toISOString()
	const existing = input.memoryId
		? await getMemoryById(input.env.APP_DB, input.userId, input.memoryId)
		: null
	if (input.memoryId && !existing) {
		throw new Error('Memory not found for this user.')
	}
	const status = input.status ?? 'active'
	const row: McpMemoryRow = existing
		? {
				...existing,
				category: normalized.category,
				status,
				subject: normalized.subject,
				summary: normalized.summary,
				details: normalized.details,
				tags_json: JSON.stringify(normalized.tags),
				source_uris_json: JSON.stringify(normalized.sourceUris),
				dedupe_key: normalized.dedupeKey,
				updated_at: now,
				deleted_at: null,
			}
		: {
				id: crypto.randomUUID(),
				user_id: input.userId,
				category: normalized.category,
				status,
				subject: normalized.subject,
				summary: normalized.summary,
				details: normalized.details,
				tags_json: JSON.stringify(normalized.tags),
				source_uris_json: JSON.stringify(normalized.sourceUris),
				dedupe_key: normalized.dedupeKey,
				created_at: now,
				updated_at: now,
				last_accessed_at: null,
				deleted_at: null,
			}

	if (existing) {
		const updated = await updateMemory(input.env.APP_DB, input.userId, row.id, {
			category: row.category,
			status: row.status,
			subject: row.subject,
			summary: row.summary,
			details: row.details,
			tags_json: row.tags_json,
			source_uris_json: row.source_uris_json,
			dedupe_key: row.dedupe_key,
			last_accessed_at: row.last_accessed_at,
			deleted_at: row.deleted_at,
		})
		if (!updated) throw new Error('Memory not found for this user.')
	} else {
		await insertMemory(input.env.APP_DB, row)
	}

	try {
		await upsertMemoryVector(input.env as Env, {
			memoryId: row.id,
			userId: input.userId,
			category: row.category,
			status: row.status,
			embedText: buildMemoryEmbedText({
				category: row.category,
				subject: row.subject,
				summary: row.summary,
				details: row.details,
				tags: normalized.tags,
				dedupeKey: row.dedupe_key,
			}),
		})
	} catch (error) {
		logMemoryVectorSyncError({
			operation: 'upsert',
			memoryId: row.id,
			userId: input.userId,
			category: row.category,
			error,
		})
	}

	const warnings =
		input.verificationReference == null ||
		input.verificationReference.trim() === ''
			? [
					'No verification_reference was supplied. Agents should run meta_memory_verify first and include a verification reference when possible.',
				]
			: []

	return {
		mode: existing ? 'updated' : 'created',
		memory: toMemoryRecord(row),
		warnings,
	}
}

export async function deleteMemory(
	input: MemoryDeleteInput,
): Promise<MemoryRecord | null> {
	const existing = await getMemoryById(
		input.env.APP_DB,
		input.userId,
		input.memoryId,
	)
	if (!existing) return null

	if (input.force) {
		const deleted = await deleteMemoryRow(
			input.env.APP_DB,
			input.userId,
			input.memoryId,
		)
		if (!deleted) return null
		try {
			await deleteMemoryVector(input.env as Env, input.memoryId)
		} catch (error) {
			logMemoryVectorSyncError({
				operation: 'delete',
				memoryId: input.memoryId,
				userId: input.userId,
				category: existing.category,
				error,
			})
		}
		return toMemoryRecord(existing)
	}

	const now = new Date().toISOString()
	const updated = await updateMemory(
		input.env.APP_DB,
		input.userId,
		input.memoryId,
		{
			category: existing.category,
			status: 'deleted',
			subject: existing.subject,
			summary: existing.summary,
			details: existing.details,
			tags_json: existing.tags_json,
			source_uris_json: existing.source_uris_json,
			dedupe_key: existing.dedupe_key,
			last_accessed_at: existing.last_accessed_at,
			deleted_at: now,
		},
	)
	if (!updated) return null

	const deletedRow = {
		...existing,
		status: 'deleted' as const,
		deleted_at: now,
		updated_at: now,
	}
	try {
		await upsertMemoryVector(input.env as Env, {
			memoryId: deletedRow.id,
			userId: input.userId,
			category: deletedRow.category,
			status: deletedRow.status,
			embedText: buildMemoryEmbedText({
				category: deletedRow.category,
				subject: deletedRow.subject,
				summary: deletedRow.summary,
				details: deletedRow.details,
				tags: parseTags(deletedRow.tags_json),
				dedupeKey: deletedRow.dedupe_key,
			}),
		})
	} catch (error) {
		logMemoryVectorSyncError({
			operation: 'upsert',
			memoryId: deletedRow.id,
			userId: input.userId,
			category: deletedRow.category,
			error,
		})
	}
	return toMemoryRecord(deletedRow)
}

export async function getMemory(
	input: MemoryGetInput,
): Promise<MemoryRecord | null> {
	const row = await getMemoryById(
		input.env.APP_DB,
		input.userId,
		input.memoryId,
	)
	return row ? toMemoryRecord(row) : null
}

export async function searchMemoryRecords(input: MemorySearchInput): Promise<{
	query: string
	matches: Array<MemorySearchMatch>
	suppressedCount: number
}> {
	const query = input.query.trim()
	if (!query) {
		return { query: '', matches: [], suppressedCount: 0 }
	}
	const rows = await listMemoriesByUserId(input.env.APP_DB, input.userId, {
		statuses: input.includeDeleted
			? ['active', 'archived', 'deleted']
			: ['active', 'archived'],
		limit: 200,
	})
	const filteredRows = rows.filter((row) => {
		if (!input.category) return true
		return (
			row.category ===
			normalizeOptionalString(input.category, maxCategoryLength)
		)
	})
	const targetLimit = normalizeLimit(input.limit)
	const rankedLimit = Math.min(filteredRows.length, targetLimit * 5)
	const { matches } = await searchMemories({
		env: input.env as Env,
		query,
		limit: rankedLimit,
		rows: filteredRows,
	})
	const filtered = await filterSuppressedMatches({
		db: input.env.APP_DB,
		userId: input.userId,
		conversationId: input.conversationId ?? null,
		includeSuppressedInConversation:
			input.includeSuppressedInConversation ?? false,
		matches,
	})
	return {
		query,
		matches: filtered.matches.slice(0, targetLimit),
		suppressedCount: filtered.suppressedCount,
	}
}

export async function verifyMemoryCandidate(input: MemoryVerifyInput): Promise<{
	candidate: {
		subject: string
		summary: string
		details: string
		category: string | null
		tags: Array<string>
		source_uris: Array<string>
		dedupe_key: string | null
	}
	relatedMemories: Array<{ memory: MemoryRecord; score: number }>
	suppressedCount: number
}> {
	const candidate = normalizeMemoryPayload(input.candidate)
	const query = buildVerifyQuery(candidate)
	const result = await searchMemoryRecords({
		env: input.env,
		userId: input.userId,
		storageContext: input.storageContext,
		query,
		limit: input.limit,
		conversationId: input.conversationId ?? null,
		includeSuppressedInConversation:
			input.includeSuppressedInConversation ?? false,
	})
	return {
		candidate: {
			subject: candidate.subject,
			summary: candidate.summary,
			details: candidate.details,
			category: candidate.category,
			tags: candidate.tags,
			source_uris: candidate.sourceUris,
			dedupe_key: candidate.dedupeKey,
		},
		relatedMemories: result.matches.map((match) => ({
			memory: mapSearchMatchToMemoryRecord(match),
			score: match.score,
		})),
		suppressedCount: result.suppressedCount,
	}
}

export async function surfaceRelevantMemories(
	input: SurfaceRelevantMemoriesInput,
): Promise<{
	memories: Array<MemoryRecord>
	suppressedCount: number
	retrievalQuery: string
}> {
	await pruneExpiredConversationSuppressions(input.env.APP_DB)
	const result = await searchMemoryRecords({
		env: input.env,
		userId: input.userId,
		storageContext: input.storageContext,
		query: input.query,
		limit: input.limit,
		conversationId: input.conversationId,
		includeSuppressedInConversation: false,
	})
	if (result.matches.length === 0) {
		return {
			memories: [],
			suppressedCount: result.suppressedCount,
			retrievalQuery: result.query,
		}
	}

	const memories = result.matches.map(mapSearchMatchToMemoryRecord)

	const memoryIds = memories.map((memory) => memory.id)
	if (memoryIds.length > 0) {
		const expiresAt = new Date(
			Date.now() + defaultSuppressionTtlMs,
		).toISOString()
		await upsertConversationSuppressions({
			db: input.env.APP_DB,
			userId: input.userId,
			conversationId: input.conversationId,
			memoryIds,
			expiresAt,
		})
		await touchMemoryAccessedAt(input.env.APP_DB, input.userId, memoryIds)
	}

	return {
		memories,
		suppressedCount: result.suppressedCount,
		retrievalQuery: result.query,
	}
}

function normalizeMemoryPayload(input: {
	category?: string | null
	subject: string
	summary: string
	details?: string | null
	tags?: Array<string> | null
	sourceUris?: Array<string> | null
	dedupeKey?: string | null
}) {
	const subject = normalizeRequiredString(
		input.subject,
		maxSubjectLength,
		'subject',
	)
	const summary = normalizeRequiredString(
		input.summary,
		maxSummaryLength,
		'summary',
	)
	return {
		category: normalizeOptionalString(input.category, maxCategoryLength),
		subject,
		summary,
		details: normalizeOptionalString(input.details, maxDetailsLength) ?? '',
		tags: normalizeTags(input.tags ?? []),
		sourceUris: normalizeSourceUris(input.sourceUris ?? []),
		dedupeKey: normalizeOptionalString(input.dedupeKey, maxDedupeKeyLength),
	}
}

function buildVerifyQuery(input: {
	category: string | null
	subject: string
	summary: string
	details: string
	tags: Array<string>
	dedupeKey: string | null
}) {
	return [
		input.category ?? '',
		input.subject,
		input.summary,
		input.details,
		input.tags.join(' '),
		input.dedupeKey ?? '',
	]
		.join('\n')
		.trim()
}

function normalizeRequiredString(
	value: string,
	maxLength: number,
	field: string,
) {
	const normalized = normalizeOptionalString(value, maxLength)
	if (!normalized) throw new Error(`Memory ${field} is required.`)
	return normalized
}

function normalizeOptionalString(
	value: string | null | undefined,
	maxLength: number,
) {
	if (value == null) return null
	const normalized = value.trim()
	if (!normalized) return null
	return normalized.length > maxLength
		? normalized.slice(0, maxLength)
		: normalized
}

function normalizeTags(tags: Array<string>) {
	return Array.from(
		new Set(
			tags
				.map((tag) => normalizeOptionalString(tag, maxTagLength))
				.filter((tag): tag is string => tag != null),
		),
	).slice(0, maxTagCount)
}

function normalizeSourceUris(sourceUris: Array<string>) {
	return Array.from(
		new Set(
			sourceUris.map((sourceUri) => {
				const normalized = sourceUri.trim()
				if (!normalized || normalized.length > maxSourceUriLength) {
					throw new Error('Memory source_uris entries must be valid URLs.')
				}
				try {
					new URL(normalized)
				} catch {
					throw new Error('Memory source_uris entries must be valid URLs.')
				}
				return normalized
			}),
		),
	).slice(0, maxSourceUriCount)
}

function normalizeLimit(value: number | undefined | null) {
	if (!Number.isFinite(value)) return 5
	return Math.max(1, Math.min(20, Math.trunc(value!)))
}

async function filterSuppressedMatches(input: {
	db: D1Database
	userId: string
	conversationId: string | null
	includeSuppressedInConversation: boolean
	matches: Array<MemorySearchMatch>
}) {
	if (
		!input.conversationId ||
		input.includeSuppressedInConversation ||
		input.matches.length === 0
	) {
		return { matches: input.matches, suppressedCount: 0 }
	}
	const suppressions = await getConversationSuppressions({
		db: input.db,
		userId: input.userId,
		conversationId: input.conversationId,
	})
	const suppressedIds = new Set(suppressions.map((entry) => entry.memory_id))
	const visible = input.matches.filter((match) => !suppressedIds.has(match.id))
	return {
		matches: visible,
		suppressedCount: input.matches.length - visible.length,
	}
}

function parseJsonStringArray(raw: string) {
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter((item): item is string => typeof item === 'string')
	} catch {
		return []
	}
}

function parseTags(raw: string) {
	return parseJsonStringArray(raw)
}

function parseSourceUris(raw: string) {
	return parseJsonStringArray(raw)
}

function mapSearchMatchToMemoryRecord(match: MemorySearchMatch): MemoryRecord {
	return {
		id: match.id,
		category: match.category,
		status: match.status,
		subject: match.subject,
		summary: match.summary,
		details: match.details,
		tags: match.tags,
		sourceUris: match.sourceUris,
		dedupeKey: match.dedupeKey,
		createdAt: match.createdAt,
		updatedAt: match.updatedAt,
		lastAccessedAt: match.lastAccessedAt,
		deletedAt: match.deletedAt,
	}
}

function toMemoryRecord(row: McpMemoryRow): MemoryRecord {
	return {
		id: row.id,
		category: row.category,
		status: row.status,
		subject: row.subject,
		summary: row.summary,
		details: row.details,
		tags: parseTags(row.tags_json),
		sourceUris: parseSourceUris(row.source_uris_json),
		dedupeKey: row.dedupe_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastAccessedAt: row.last_accessed_at,
		deletedAt: row.deleted_at,
	}
}
