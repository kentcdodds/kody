import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { createDefaultMcpCallerContext } from './mcp/context.ts'

export function createChatMcpCallerContext(input: {
	baseUrl: string
	user: McpUserContext
}) {
	return createDefaultMcpCallerContext(input)
}
