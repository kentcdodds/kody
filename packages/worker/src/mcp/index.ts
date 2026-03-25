import * as Sentry from '@sentry/cloudflare'
import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { __DO_NOT_USE_WILL_BREAK__agentContext } from 'agents'
import { McpAgent } from 'agents/mcp'
import { capabilityDomains } from '#mcp/capabilities/registry.ts'
import { buildSentryOptions } from '../sentry-options.ts'
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
This is a three-part system:
1. Use 'search' to discover builtin capabilities, saved skills, and saved apps (when authenticated).
2. Use 'execute' to call builtin capabilities via 'codemode[capabilityName](args)', or use meta domain tools to run saved skills.
3. Use 'open_generated_ui' to open a generic MCP App shell with inline generated code or a saved app by id.

Quick start
- Call 'search' first to discover what Kody can do (results include type 'capability', 'skill', or 'app').
- Call 'execute' or 'meta_run_skill' next to run capability code.
- Call 'open_generated_ui' when you want an interactive UI rendered in an MCP App host.
- Use 'meta_save_skill' only for workflows that are reasonably repeatable—patterns you expect to run again with similar structure or inputs. Do not save one-off tasks, unique ad-hoc work, or highly bespoke requests as skills; run those with 'execute' instead. Use 'meta_update_skill' to replace an existing skill's code in place.
- When a saved skill declares parameters, pass values via meta_run_skill params; the codemode can read them from the params variable.
- Use 'ui_save_app' to persist reusable UI source for later reopening via 'app_id'. Saved apps are user-scoped UI artifacts, not codemode skills.

Kody source repository
- Kody (this app and MCP server) is developed at https://github.com/kentcdodds/kody. When you launch a Cursor Cloud Agent to improve Kody itself, use that repository URL (unless the user explicitly points you at another fork or repo).

Domains
${domainInstructions}

How to use search
- Call the 'search' tool with a natural-language 'query' describing what you need (optional 'limit', 'detail').
- Narrow results by rephrasing 'query'—there are no structured filter arguments.
- Saved skills appear when the MCP client provides an authenticated user; use 'meta_get_skill' for full skill code.
- Use domain descriptions above as vocabulary hints in your query text.
- Use 'detail: true' when you need full JSON schemas and metadata.
- Example: search({ query: 'saved dashboard app or generated UI shell' })
- Example: search({ query: 'GitHub REST API repository or issues', detail: true })
- Example: search({ query: 'Cursor Cloud agents API' })
- Example: search({ query: 'Cloudflare API zones dns workers d1', detail: true })
- Example: search({ query: 'GitHub REST API documentation markdown' })
- Example: search({ query: 'Cursor Cloud Agents API documentation markdown' })
- Example: search({ query: 'Cloudflare API docs markdown' })

Destructive GitHub access
- Some capabilities are marked destructive: they can change or delete remote data (for example github_rest with POST, PUT, PATCH, or DELETE).
- GitHub requests run as the configured token identity; in production this is intended to be the kody-bot account rather than kentcdodds.
- Before execute on a destructive or mutating call, confirm the exact path, method, and payload with the user unless they already asked for that precise operation.

Destructive Cursor Cloud Agents access
- The cursor_cloud_rest capability can launch, stop, delete, or otherwise change Cursor Cloud Agents (POST/PUT/PATCH/DELETE). Writes may consume Cursor quota when calling the real API.
- Official endpoints and request bodies: https://cursor.com/docs/cloud-agent/api/endpoints
- Before execute on a mutating call, confirm the exact path, method, and JSON body with the user unless they already approved that exact operation.

Destructive Cloudflare access
- The cloudflare_rest capability can change or delete Cloudflare resources such as DNS records, Workers settings, routes, or account configuration (POST/PUT/PATCH/DELETE).
- Official API base path and auth: https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/
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
- Use 'open_generated_ui' when you want an interactive UI in MCP App compatible hosts.
- Pass either inline source code with 'code' or reopen a saved app with 'app_id' (exactly one is allowed).
- Prefer body-focused HTML fragments when possible, but full HTML documents are also supported.
- The shell exposes a small standard library on 'window.kodyWidget' for follow-up messages, external links, fullscreen requests, and 'executeCode(code)'.
- 'executeCode(code)' sends the request back to the host, which calls the MCP tool 'execute' with that same code string.
- The shell also provides lightweight semantic HTML styles plus theme tokens such as '--color-*', '--spacing-*', '--radius-*', '--shadow-*', and '--font-*'.
	`.trim(),
} as const

const patchedStreamableTransports = new WeakSet<object>()

type StreamableMcpTransport = {
	send: (message: unknown, options?: unknown) => Promise<void>
}

class MCPBase extends McpAgent<Env, State, Props> {
	server = new McpServer(serverMetadata.implementation, {
		instructions: serverMetadata.instructions,
		jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
	})
	/**
	 * `@modelcontextprotocol/sdk` handles inbound JSON-RPC via `Promise.resolve().then(...)`
	 * so `transport.send` often runs in a later microtask. By then the `agents` library's
	 * `AsyncLocalStorage` scope from the WebSocket `onConnect` callback has ended, so
	 * `getCurrentAgent()` inside `StreamableHTTPServerTransport.send` is empty and
	 * responses are never written (MCP client hits its 60s request timeout).
	 *
	 * Re-enter agent context whenever send runs without an active store so deferred
	 * replies still resolve `getCurrentAgent()` to this Durable Object instance.
	 */
	override async onStart(props?: Props) {
		await super.onStart(props)
		const transport = (this as unknown as { _transport?: unknown })._transport
		if (
			!transport ||
			typeof transport !== 'object' ||
			patchedStreamableTransports.has(transport)
		) {
			return
		}
		const withSend = transport as StreamableMcpTransport
		if (typeof withSend.send !== 'function') return
		patchedStreamableTransports.add(transport)
		const originalSend = withSend.send.bind(
			transport,
		) as StreamableMcpTransport['send']
		const self = this
		withSend.send = async (message, options) => {
			const store = __DO_NOT_USE_WILL_BREAK__agentContext.getStore()
			// Only trust the active store when it is *this* DO. Any other truthy
			// `store.agent` (e.g. another agent/async branch) would make
			// StreamableHTTPServerTransport.send use the wrong `getCurrentAgent()` and
			// fail to route JSON-RPC replies—clients then hang until MCP timeout.
			if (store?.agent === self) {
				return originalSend(message, options)
			}
			return __DO_NOT_USE_WILL_BREAK__agentContext.run(
				{
					agent: self,
					connection: undefined,
					request: undefined,
					email: undefined,
				},
				() => originalSend(message, options),
			)
		}
	}
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
