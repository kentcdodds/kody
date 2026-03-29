import * as Sentry from '@sentry/cloudflare'
import { type exports as workerExports } from 'cloudflare:workers'
import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { builtinDomains } from '#mcp/capabilities/builtin-domains.ts'
import { buildSentryOptions } from '../sentry-options.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { registerResources } from './register-resources.ts'
import { registerTools } from './register-tools.ts'

export type State = {}
export type Props = McpServerProps

const domainInstructions = builtinDomains
	.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
	.join('\n')

const serverMetadata = {
	implementation: {
		name: 'kody-mcp',
		version: '1.0.0',
	},
	instructions: `
This is a three-part system:
1. Use 'search' to discover builtin capabilities, saved skills, saved apps, and reusable user secret references.
2. Use 'execute' to call builtin capabilities via 'codemode[capabilityName](args)', or use meta domain tools to run saved skills.
3. Use 'open_generated_ui' to open a generic MCP App runtime with inline generated code or a saved app by id.

Quick start
- Call 'search' first to discover what Kody can do (results include type 'capability', 'skill', 'app', or 'secret').
- Call 'execute' or 'meta_run_skill' next to run capability code.
- Call 'open_generated_ui' when you want an interactive UI rendered in an MCP App host.
- Never ask the user to paste secrets, tokens, API keys, passwords, OAuth codes, or client secrets into chat. Use saved secrets when available, or use 'open_generated_ui' to collect and save sensitive values instead.
- Use 'meta_save_skill' only for workflows that are reasonably repeatable—patterns you expect to run again with similar structure or inputs. Do not save one-off tasks, unique ad-hoc work, or highly bespoke requests as skills; run those with 'execute' instead. Use 'meta_update_skill' to replace an existing skill's code in place.
- When a saved skill declares parameters, pass values via meta_run_skill params; the codemode can read them from the params variable.
- Use 'ui_save_app' to persist reusable UI source for later reopening via 'app_id'. Saved apps are user-scoped UI artifacts, not codemode skills.
- Use \`codemode.secret_list(args)\` during execute-time code to list secret metadata only; it does not return plaintext values.

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
- Example: search({ query: 'saved dashboard app or generated UI runtime' })
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
- Use \`await codemode.secret_list({})\` or \`await codemode.secret_list({ scope: 'app' })\` when you need secret metadata such as names, descriptions, scopes, allowed hosts, and allowed capabilities from the sandbox.
- Use \`await codemode.value_get({ name })\` or \`await codemode.value_list({ scope })\` for readable non-secret configuration that generated UI code should be able to store and read back later.
- Use normal \`fetch(...)\` for outbound HTTP. To inject a stored secret, place a placeholder such as \`{{secret:cloudflareToken}}\` or \`{{secret:cloudflareToken|scope=user}}\` in the URL, headers, or request body; the host resolves it server-side and blocks unapproved destinations.
- Some capability input fields also accept secret placeholders. When an input schema marks a string field with \`x-kody-secret: true\`, you may pass \`{{secret:name}}\` or \`{{secret:name|scope=user}}\` there instead of a raw value. If that secret has an allowed-capabilities policy, the current capability name must be on the allowlist.
- Secret placeholders are not general-purpose string interpolation. Do not use \`execute\` to build a string or object that merely returns \`{{secret:...}}\`; those placeholders only resolve in secret-aware fetch paths or capability inputs that explicitly opt into \`x-kody-secret\`.
- Saving or updating a secret does not authorize sending it anywhere. If a fetch fails because a host is not approved for that secret, ask the user whether to open the approval link and approve that host in the web app.
- Secrets are intentionally not readable or updatable through \`codemode\`. Never ask the user to paste a secret into chat; use generated UI flows such as \`saveSecret(...)\` when the user needs to provide or rotate a value, and use \`codemode.secret_delete(...)\` only when removing a stored secret reference.
- Your code should either be an async arrow function that returns the result, or a module that default-exports an async function when using imports.
- Example: const result = await codemode[capabilityName](args)

MCP App tools
- Use 'open_generated_ui' when you want an interactive UI in MCP App compatible hosts.
- Pass either inline source code with 'code' or reopen a saved app with 'app_id' (exactly one is allowed).
- Prefer body-focused HTML fragments when possible, but full HTML documents are also supported.
- Use generated UI whenever the user needs to enter a sensitive value. Do not ask the user to paste secrets or credentials into chat.
- Generated UI code can import \`{ kodyWidget }\` from \`@kody/ui-utils\` and use helpers for follow-up messages, external links, fullscreen requests, \`executeCode(code)\`, secret management, values, forms, OAuth, and secret-aware fetches.
- 'executeCode(code)' is the low-level transport for server-side generated UI work. Prefer the higher-level secret and value helpers when they fit the task.
- If a generated UI encounters a recoverable runtime issue, have it show the problem locally and also call 'sendMessage(...)' with the next action the user should take so the parent chat can continue the workflow.
- The shell also provides lightweight semantic HTML styles plus theme tokens such as '--color-*', '--spacing-*', '--radius-*', '--shadow-*', and '--font-*'.
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
