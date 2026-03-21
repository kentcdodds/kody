import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export function requireMcpUser(context: McpCallerContext) {
	if (!context.user) {
		throw new Error('Authenticated MCP user is required for this capability.')
	}
	return context.user
}
