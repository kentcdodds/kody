import * as Sentry from '@sentry/cloudflare'
import { type exports as workerExports } from 'cloudflare:workers'
import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { buildSentryOptions } from '../sentry-options.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { registerResources } from './register-resources.ts'
import {
	buildMcpServerInstructions,
	conversationIdGuidance,
} from './server-instructions.ts'
import { registerTools } from './register-tools.ts'
import { getMcpUserServerInstructions } from './user-server-instructions-repo.ts'

export type State = {
	searchConversationIdsWithPreamble?: Array<string>
}
export type Props = McpServerProps

export { conversationIdGuidance }

const serverImplementation = {
	name: 'kody-mcp',
	version: '1.0.0',
} as const

class MCPBase extends McpAgent<Env, State, Props> {
	initialState: State = {
		searchConversationIdsWithPreamble: [],
	}
	declare server: McpServer
	async init() {
		const caller = this.getCallerContext()
		const userId = caller.user?.userId ?? null
		const overlay =
			userId !== null
				? await getMcpUserServerInstructions(this.env.APP_DB, userId)
				: null
		this.server = new McpServer(serverImplementation, {
			instructions: buildMcpServerInstructions(overlay),
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		})
		await registerResources(this)
		await registerTools(this)
	}
	getCallerContext() {
		return parseMcpCallerContext(this.props)
	}
	getEnv() {
		return this.env
	}
	getLoopbackExports() {
		return this.ctx.exports as typeof workerExports
	}
	requireDomain() {
		const { baseUrl } = this.getCallerContext()
		invariant(
			baseUrl,
			'This should never happen, but somehow we did not get the baseUrl from the request handler',
		)
		return baseUrl
	}
}

export const MCP = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	MCPBase,
)

/** Agent instance type for tool/resource registration (the Durable Object export is a wrapped class). */
export type MCP = InstanceType<typeof MCP>
