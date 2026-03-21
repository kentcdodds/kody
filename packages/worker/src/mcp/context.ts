import { parseSafe } from 'remix/data-schema'
import {
	mcpCallerContextSchema,
	type McpCallerContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'

export type McpServerProps = McpCallerContext

export function createMcpCallerContext(input: {
	baseUrl: string
	user?: McpUserContext | null
}): McpCallerContext {
	return {
		baseUrl: input.baseUrl,
		user: input.user ?? null,
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
