import { parseSafe } from 'remix/data-schema'
import {
	mcpCallerContextSchema,
	type McpCallerContext,
	type McpExecutionOrigin,
	type McpRepoContext,
	type McpStorageContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'

export type McpServerProps = McpCallerContext

export function createMcpCallerContext(input: {
	baseUrl: string
	executionOrigin?: McpExecutionOrigin
	user?: McpUserContext | null
	storageContext?: McpStorageContext | null
	repoContext?: McpRepoContext | null
}): McpCallerContext {
	return {
		baseUrl: input.baseUrl,
		executionOrigin: input.executionOrigin,
		user: input.user ?? null,
		storageContext: input.storageContext ?? null,
		repoContext: input.repoContext ?? null,
	}
}

export function parseMcpCallerContext(value: unknown): McpCallerContext {
	const result = parseSafe(mcpCallerContextSchema, value)
	if (!result.success) {
		const message = result.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid MCP caller context: ${message}`)
	}
	return result.value
}
