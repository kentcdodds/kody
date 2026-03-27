import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export type McpRegistrationAgent = {
	server: McpServer
	getEnv(): Env
	getCallerContext(): McpCallerContext
	requireDomain(): string
	getLoopbackExports(): Cloudflare.Exports
}
