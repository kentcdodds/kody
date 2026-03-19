import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { registerResources } from './register-resources.ts'
import { registerTools } from './register-tools.ts'

export type State = {}
export type Props = McpServerProps

const serverMetadata = {
	implementation: {
		name: 'kody-mcp',
		version: '1.0.0',
	},
	instructions: `
This is a two-step system:
1. Use 'search' to discover capabilities.
2. Use 'execute' to call them via 'codemode[capabilityName](args)'.

Quick start
- Call 'search' first to discover what Kody can do.
- Call 'execute' next to run the capability you found.

How to use search
- The sandbox provides a 'capabilities' object keyed by name.
- Use 'findCapabilities(...)' as the default helper for targeted discovery.
- Use 'getCapability(name)' for exact-name lookup when you already know the capability.
- Use the raw 'capabilities' map for arbitrary JavaScript queries that are not covered by the helper parameters.
- 'findCapabilities(...)' returns a compact summary by default.
- Use 'detail: true' or 'getCapability(name)' when you need richer metadata or schemas.
- Your code must be an async arrow function that returns the result.
- Example: findCapabilities({ domain: 'math', inputField: 'operator' })

How to use execute
- The sandbox provides a 'codemode' object with async methods for each capability.
- Use capability names discovered from search.
- Pass one args object that matches the capability inputSchema.
- Each capability call returns that capability's raw structured result value.
- When chaining calls, read fields from the previous result using its outputSchema.
- Chain multiple calls, use conditionals, and return structured results.
- Your code must be an async arrow function that returns the result.
- Example: const result = await codemode[capabilityName](args)

MCP App tools
- Use 'open_calculator_ui' when you want an interactive calculator widget in MCP App compatible hosts.
	`.trim(),
} as const

export class MCP extends McpAgent<Env, State, Props> {
	server = new McpServer(serverMetadata.implementation, {
		instructions: serverMetadata.instructions,
		jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
	})
	async init() {
		await registerResources(this)
		await registerTools(this)
	}
	getCallerContext() {
		return parseMcpCallerContext(this.props)
	}
	getEnv() {
		return this.env
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
