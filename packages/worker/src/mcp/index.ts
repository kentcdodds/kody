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

export type State = {
	searchConversationIdsWithPreamble?: Array<string>
}
export type Props = McpServerProps

const domainInstructions = builtinDomains
	.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
	.join('\n')

export const conversationIdGuidance =
	'The public MCP tools accept optional `conversationId` and `memoryContext` fields. `conversationId` ties related calls together. On the first call, omit it to receive a server-generated ID, or supply your own. Pass the returned `conversationId` on every subsequent call in the same conversation - this enables optimizations like reduced response size. Generated values should be short and random enough to avoid collisions.'

const serverMetadata = {
	implementation: {
		name: 'kody-mcp',
		version: '1.0.0',
	},
	instructions: `
End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use

Three-step flow:
1. \`search\` — builtin capabilities, saved skills, saved apps, secret references (metadata).
2. \`execute\` — \`codemode[capabilityName](args)\`; saved skills via \`meta_run_skill\` or inline code from \`meta_get_skill\`.
3. \`open_generated_ui\` — MCP App runtime (\`code\` or \`app_id\`).

Conventions
- ${conversationIdGuidance}
- \`memoryContext\`: short and task-focused; reserved for future memory behavior (not persisted or used for retrieval yet).
- Do not ask the user to paste secrets in chat; use saved secrets or \`open_generated_ui\`.
- \`meta_save_skill\`: repeatable workflows only; optional \`collection\`; same name replaces an existing skill. One-off work: \`execute\`. Skill params: pass via \`meta_run_skill\` → \`params\` in codemode.
- \`ui_save_app\` / \`app_id\`: persisted UI artifacts (hidden from search unless \`hidden: false\`). \`codemode.secret_list\` / \`secret_set\`: metadata-only list; set only for values already in trusted execution (see \`execute\` tool description).

Kody repository (for contributors): https://github.com/kentcdodds/kody

Domains
${domainInstructions}

search
- \`query\`: natural language; results are ranked (order matters). Optional \`limit\`, \`maxResponseSize\`, \`skill_collection\`.
- \`entity: "{id}:{type}"\` (\`capability\` | \`skill\` | \`app\` | \`secret\`) for one entity’s detail (schemas, usage). If a \`query\` returns no useful hits, rephrase or call \`meta_list_capabilities\` — \`entity\` does not repair an empty ranked list.
- Saved skills/apps need an authenticated user. Examples:
  - search({ query: 'saved dashboard app or generated UI runtime' })
  - search({ query: 'Cloudflare API zones dns workers d1' })
  - search({ entity: 'page_to_markdown:capability' })

execute
- Async arrow function; \`codemode\` + OAuth helpers \`refreshAccessToken\` / \`createAuthenticatedFetch\`. Prefer one \`execute\` when the plan is clear. Full rules for \`fetch\`, placeholders, \`secret_list\` / \`value_get\`, and \`x-kody-secret\`: see the \`execute\` tool description.

Cloudflare API (from \`execute\` or saved skills): \`fetch\` to \`https://api.cloudflare.com\` with \`Authorization: Bearer {{secret:…}}\` after host approval. Pattern: \`docs/contributing/skill-patterns/cloudflare-api-v4.md\`. Docs: https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/
- Before POST/PUT/PATCH/DELETE to Cloudflare, GitHub, Cursor Cloud Agents, or similar: confirm path, method, and body with the user unless they already approved that exact operation.

open_generated_ui
- Exactly one of \`code\` or \`app_id\`. Sensitive input: use UI; import \`kodyWidget\` from \`@kody/ui-utils\`. Details: \`open_generated_ui\` tool description.
	`.trim(),
} as const

class MCPBase extends McpAgent<Env, State, Props> {
	initialState: State = {
		searchConversationIdsWithPreamble: [],
	}
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
