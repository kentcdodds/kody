import * as Sentry from '@sentry/cloudflare'
import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { capabilityDomains } from '#mcp/capabilities/registry.ts'
import { buildSentryOptions } from '#sentry/cloudflare-options.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { registerResources } from './register-resources.ts'
import { registerTools } from './register-tools.ts'

export type State = {}
export type Props = McpServerProps

const domainInstructions = capabilityDomains
	.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
	.join('\n')

const serverMetadata = {
	implementation: {
		name: 'kody-mcp',
		version: '1.0.0',
	},
	instructions: `
This is a two-step system:
1. Use 'search' to discover builtin capabilities and saved skills (when authenticated).
2. Use 'execute' to call them via 'codemode[capabilityName](args)', or use meta domain tools to run saved skills.

Quick start
- Call 'search' first to discover what Kody can do (results include type 'capability' or 'skill').
- Call 'execute' or 'meta_run_skill' next to run code; use 'meta_save_skill' to persist reusable codemode; use 'meta_update_skill' to replace an existing skill's code in place.

Domains
${domainInstructions}

How to use search
- Call the 'search' tool with a natural-language 'query' describing what you need (optional 'limit', 'detail').
- Narrow results by rephrasing 'query'—there are no structured filter arguments.
- Saved skills appear when the MCP client provides an authenticated user; use 'meta_get_skill' for full skill code.
- Use domain descriptions above as vocabulary hints in your query text.
- Use 'detail: true' when you need full JSON schemas and metadata.
- Example: search({ query: 'calculator or basic arithmetic on two numbers' })
- Example: search({ query: 'GitHub REST API repository or issues', detail: true })
- Example: search({ query: 'Cursor Cloud agents API' })

Destructive GitHub access
- Some capabilities are marked destructive: they can change or delete remote data (for example github_rest with POST, PUT, PATCH, or DELETE).
- GitHub requests run as the configured token identity; in production this is intended to be the kody-bot account rather than kentcdodds.
- Before execute on a destructive or mutating call, confirm the exact path, method, and payload with the user unless they already asked for that precise operation.

Destructive Cursor Cloud Agents access
- The cursor_cloud_rest capability can launch, stop, delete, or otherwise change Cursor Cloud Agents (POST/PUT/PATCH/DELETE). Writes may consume Cursor quota when calling the real API.
- Official endpoints and request bodies: https://cursor.com/docs/cloud-agent/api/endpoints
- Before execute on a mutating call, confirm the exact path, method, and JSON body with the user unless they already approved that exact operation.

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

class MCPBase extends McpAgent<Env, State, Props> {
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

export const MCP = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	MCPBase,
)

/** Agent instance type for tool/resource registration (the Durable Object export is a wrapped class). */
export type MCP = InstanceType<typeof MCP>
