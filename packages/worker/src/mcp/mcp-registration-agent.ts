import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export type McpRegistrationAgent = {
	server: McpServer
	getEnv(): Env
	getCallerContext(): McpCallerContext
	requireDomain(): string
	getLoopbackExports(): Cloudflare.Exports
	/**
	 * Durable Object `ctx.waitUntil`, when the agent runs inside one. Tool
	 * handlers hand observability writes (run records, usage) to it so those
	 * writes do not serialize the response they observe.
	 */
	waitUntil?(promise: Promise<unknown>): void
}
