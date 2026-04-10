import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { surfaceRelevantMemories } from '#mcp/memory/service.ts'
import { type MemoryRecord } from '#mcp/memory/types.ts'

export type MemoryToolSummary = {
	memories: Array<{
		id: string
		category: string | null
		status: string
		subject: string
		summary: string
		details: string
		tags: Array<string>
		updatedAt: string
	}>
	suppressedCount: number
	retrievalQuery: string
}

export async function loadRelevantMemoriesForTool(input: {
	env: Pick<Env, 'APP_DB' | 'AI'> &
		Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>
	callerContext: McpCallerContext
	conversationId: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	limit?: number
}): Promise<MemoryToolSummary | null> {
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	const retrievalQuery = buildMemoryRetrievalQuery(input.memoryContext)
	if (!retrievalQuery) return null
	const result = await surfaceRelevantMemories({
		env: input.env,
		userId,
		storageContext: {
			sessionId: input.callerContext.storageContext?.sessionId ?? null,
			appId: input.callerContext.storageContext?.appId ?? null,
		},
		query: retrievalQuery,
		conversationId: input.conversationId,
		limit: input.limit,
	})
	if (result.memories.length === 0) {
		return {
			memories: [],
			suppressedCount: result.suppressedCount,
			retrievalQuery: result.retrievalQuery,
		}
	}
	return {
		memories: result.memories.map(toMemoryToolSummaryItem),
		suppressedCount: result.suppressedCount,
		retrievalQuery: result.retrievalQuery,
	}
}

export async function surfaceToolMemories(input: {
	env: Pick<Env, 'APP_DB' | 'AI'> &
		Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>>
	callerContext: McpCallerContext
	conversationId: string
	retrievalQuery: string
	limit?: number
}) {
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	const retrievalQuery = input.retrievalQuery.trim()
	if (!retrievalQuery) return null
	const result = await surfaceRelevantMemories({
		env: input.env,
		userId,
		storageContext: {
			sessionId: input.callerContext.storageContext?.sessionId ?? null,
			appId: input.callerContext.storageContext?.appId ?? null,
		},
		query: retrievalQuery,
		conversationId: input.conversationId,
		limit: input.limit,
	})
	return {
		memories: result.memories.map(toMemoryToolSummaryItem),
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
	if (!memorySummary || memorySummary.memories.length === 0) return []
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
		},
	}
}

function formatRelevantMemoriesMarkdown(memorySummary: MemoryToolSummary) {
	const lines = ['## Relevant memories', '']
	for (const memory of memorySummary.memories) {
		lines.push(`- **${memory.subject}** — ${memory.summary}`)
		if (memory.category) {
			lines.push(`  - Category: \`${memory.category}\``)
		}
		if (memory.tags.length > 0) {
			lines.push(
				`  - Tags: ${memory.tags.map((tag) => `\`${tag}\``).join(', ')}`,
			)
		}
		lines.push(`  - Updated: \`${memory.updatedAt}\``)
	}
	if (memorySummary.suppressedCount > 0) {
		lines.push(
			'',
			`Suppressed ${memorySummary.suppressedCount} previously surfaced memories for this conversation.`,
		)
	}
	return lines.join('\n')
}

function toMemoryToolSummaryItem(memory: MemoryRecord) {
	return {
		id: memory.id,
		category: memory.category,
		status: memory.status,
		subject: memory.subject,
		summary: memory.summary,
		details: memory.details,
		tags: memory.tags,
		updatedAt: memory.updatedAt,
	}
}
