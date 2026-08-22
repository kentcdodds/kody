import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	acknowledgeSurfacedMemories,
	searchMemoryRecords,
} from '#mcp/memory/service.ts'
import { type MemoryRecord } from '#mcp/memory/types.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'

export type MemoryToolSummary = {
	memories: Array<{
		id: string
		subject: string
		summary: string
	}>
	retrieverResults: Array<PackageRetrieverSurfaceResult>
	retrieverWarnings: Array<string>
	suppressedCount: number
	retrievalQuery: string
}

/** Single-list RRF rank-1 at k=60 is 1/61. Used by tests as the inject floor. */
export const automaticMemorySingleListRankOneScore = 1 / 61
/** Auto-surface keeps the top ranked active hits, not an absolute score cut. */
const automaticMemorySurfaceLimit = 2

function memoryDedupeKey(match: { dedupeKey?: string | null }) {
	const key = match.dedupeKey?.trim() ?? ''
	return key.length > 0 ? key : null
}

function selectAutomaticMemories<
	T extends {
		status: string
		dedupeKey?: string | null
	},
>(matches: Array<T>) {
	const selected: Array<T> = []
	const seenKeys = new Set<string>()
	for (const match of matches) {
		if (match.status !== 'active') continue
		const key = memoryDedupeKey(match)
		if (key !== null) {
			if (seenKeys.has(key)) continue
			seenKeys.add(key)
		}
		selected.push(match)
		if (selected.length >= automaticMemorySurfaceLimit) break
	}
	return selected
}

async function loadAutomaticMemories(input: {
	env: Pick<Env, 'APP_DB'> & Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>
	callerContext: McpCallerContext
	userId: string
	query: string
	conversationId: string
	limit?: number
	acknowledgeSurfaced?: boolean
}) {
	const result = await searchMemoryRecords({
		env: input.env,
		userId: input.userId,
		storageContext: {
			sessionId: input.callerContext.storageContext?.sessionId ?? null,
			appId: input.callerContext.storageContext?.appId ?? null,
		},
		query: input.query,
		conversationId: input.conversationId,
		// Default search already returns 5; keep at least n=2 plus overscan so a
		// collapsed `dedupe_key` pair can still fill the second slot.
		limit: Math.max(input.limit ?? 5, automaticMemorySurfaceLimit * 2 + 1),
		includeSuppressedInConversation: true,
	})
	const memories = selectAutomaticMemories(result.matches)
	return {
		memories,
		suppressedCount: result.suppressedCount,
		retrievalQuery: result.query,
	}
}

async function runContextPackageRetrievers(input: {
	env: Env
	baseUrl: string
	userId: string
	query: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId: string
}) {
	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')
	return await runPackageRetrievers({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		scope: 'context',
		query: input.query,
		memoryContext: input.memoryContext,
		conversationId: input.conversationId,
		maxProviders: 3,
	})
}

export async function loadRelevantMemoriesForTool(input: {
	env: Pick<Env, 'APP_DB'> & Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>
	callerContext: McpCallerContext
	conversationId: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	limit?: number
	acknowledgeSurfaced?: boolean
}): Promise<MemoryToolSummary | null> {
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	const retrievalQuery = buildMemoryRetrievalQuery(input.memoryContext)
	if (!retrievalQuery) return null
	const [result, retrieverResult] = await Promise.all([
		loadAutomaticMemories({
			env: input.env,
			callerContext: input.callerContext,
			userId,
			query: retrievalQuery,
			conversationId: input.conversationId,
			limit: input.limit,
			acknowledgeSurfaced: input.acknowledgeSurfaced,
		}),
		runContextPackageRetrievers({
			env: input.env as Env,
			baseUrl: input.callerContext.baseUrl,
			userId,
			query: retrievalQuery,
			memoryContext: input.memoryContext,
			conversationId: input.conversationId,
		}),
	])
	if (result.memories.length === 0 && retrieverResult.results.length === 0) {
		return {
			memories: [],
			retrieverResults: [],
			retrieverWarnings: retrieverResult.warnings,
			suppressedCount: result.suppressedCount,
			retrievalQuery: result.retrievalQuery,
		}
	}
	return {
		memories: result.memories.map(toMemoryToolSummaryItem),
		retrieverResults: retrieverResult.results,
		retrieverWarnings: retrieverResult.warnings,
		suppressedCount: result.suppressedCount,
		retrievalQuery: result.retrievalQuery,
	}
}

export async function acknowledgeToolMemories(input: {
	env: Pick<Env, 'APP_DB'> & Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>
	callerContext: McpCallerContext
	conversationId: string
	memoryIds: Array<string>
}) {
	const userId = input.callerContext.user?.userId ?? null
	if (!userId || input.memoryIds.length === 0) return
	await acknowledgeSurfacedMemories({
		env: input.env,
		userId,
		conversationId: input.conversationId,
		memoryIds: input.memoryIds,
	})
}

export async function surfaceToolMemories(input: {
	env: Pick<Env, 'APP_DB'> & Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>
	callerContext: McpCallerContext
	conversationId: string
	retrievalQuery: string
	limit?: number
}) {
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	const retrievalQuery = input.retrievalQuery.trim()
	if (!retrievalQuery) return null
	const [result, retrieverResult] = await Promise.all([
		loadAutomaticMemories({
			env: input.env,
			callerContext: input.callerContext,
			userId,
			query: retrievalQuery,
			conversationId: input.conversationId,
			limit: input.limit,
		}),
		runContextPackageRetrievers({
			env: input.env as Env,
			baseUrl: input.callerContext.baseUrl,
			userId,
			query: retrievalQuery,
			conversationId: input.conversationId,
		}),
	])
	return {
		memories: result.memories.map(toMemoryToolSummaryItem),
		retrieverResults: retrieverResult.results,
		retrieverWarnings: retrieverResult.warnings,
		suppressedCount: result.suppressedCount,
		retrievalQuery: result.retrievalQuery,
	} satisfies MemoryToolSummary
}

export function buildMemoryRetrievalQuery(
	input:
		| {
				task?: string
				query?: string
				entities?: Array<string>
				constraints?: Array<string>
		  }
		| null
		| undefined,
) {
	if (!input) return ''
	const parts = [
		input.task?.trim() ?? '',
		input.query?.trim() ?? '',
		...(input.entities ?? []).map((value) => value.trim()),
		...(input.constraints ?? []).map((value) => value.trim()),
	].filter((value) => value.length > 0)
	return Array.from(new Set(parts)).join('\n')
}

export function formatSurfacedMemoriesMarkdown(
	memorySummary: MemoryToolSummary | null,
) {
	if (
		!memorySummary ||
		(memorySummary.memories.length === 0 &&
			memorySummary.retrieverResults.length === 0)
	) {
		return []
	}
	return [
		{
			type: 'text',
			text: formatRelevantMemoriesMarkdown(memorySummary),
		},
	] satisfies Array<ContentBlock>
}

export function buildMemoryStructuredContent(
	memorySummary: MemoryToolSummary | null,
) {
	if (!memorySummary) return {}
	return {
		memories: {
			surfaced: memorySummary.memories,
			suppressedCount: memorySummary.suppressedCount,
			retrievalQuery: memorySummary.retrievalQuery,
			retrieverResults: memorySummary.retrieverResults,
			retrieverWarnings: memorySummary.retrieverWarnings,
		},
	}
}

function formatRelevantMemoriesMarkdown(memorySummary: MemoryToolSummary) {
	const lines: Array<string> = []
	if (memorySummary.memories.length > 0) {
		lines.push('## Relevant memories', '')
		for (const memory of memorySummary.memories) {
			lines.push(`- **${memory.subject}** — ${memory.summary}`)
		}
	}
	if (memorySummary.retrieverResults.length > 0) {
		if (lines.length > 0) lines.push('')
		lines.push('## Relevant retriever results', '')
		for (const result of memorySummary.retrieverResults) {
			lines.push(
				`- **${escapeMarkdownText(result.title)}** — ${escapeMarkdownText(result.summary)} (${formatMarkdownInlineCode(`${result.kodyId}/${result.retrieverKey}`)})`,
			)
			if (result.source) {
				lines.push(`  - Source: ${formatMarkdownInlineCode(result.source)}`)
			}
			if (result.url) {
				lines.push(`  - URL: ${formatMarkdownInlineCode(result.url)}`)
			}
		}
	}
	if (memorySummary.retrieverWarnings.length > 0) {
		lines.push('', '## Retriever warnings', '')
		for (const warning of memorySummary.retrieverWarnings) {
			lines.push(`- ${escapeMarkdownText(warning)}`)
		}
	}
	if (memorySummary.suppressedCount > 0) {
		lines.push(
			'',
			`Suppressed ${memorySummary.suppressedCount} memories surfaced earlier in this conversation.`,
		)
	}
	return lines.join('\n')
}

function toMemoryToolSummaryItem(memory: MemoryRecord) {
	return {
		id: memory.id,
		subject: memory.subject,
		summary: memory.summary,
	}
}
