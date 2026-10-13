import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

/** The signed-in person. Callers may pass a full caller context or just `user`. */
export function requireMcpUser(context: { user?: McpCallerContext['user'] }) {
	if (!context.user) {
		throw new Error('Authenticated MCP user is required for this capability.')
	}
	return context.user
}

/** The org-bound request. Callers may pass a full caller context or just `request`. */
export function requireMcpRequest(context: {
	request?: McpCallerContext['request']
}) {
	if (!context.request) {
		throw new Error('Authenticated MCP user is required for this capability.')
	}
	return context.request
}
