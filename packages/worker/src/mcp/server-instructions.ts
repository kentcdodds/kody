import { builtinDomains } from '#mcp/capabilities/builtin-domains.ts'

const domainInstructions = builtinDomains
	.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
	.join('\n')

export const conversationIdGuidance =
	'The public MCP tools accept optional `conversationId` and `memoryContext` fields. `conversationId` ties related calls together. On the first call, omit it to receive a server-generated ID, or supply your own. Pass the returned `conversationId` on every subsequent call in the same conversation - this enables optimizations like reduced response size. Generated values should be short and random enough to avoid collisions.'

export function buildBaseMcpServerInstructions(): string {
	return `
End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use

Three-step flow:
1. \`search\` — builtin capabilities, saved skills, saved apps, secret references (metadata).
2. \`execute\` — \`codemode[capabilityName](args)\`; saved skills via \`meta_run_skill\` or inline code from \`meta_get_skill\`.
3. \`open_generated_ui\` — MCP App runtime (\`code\` or \`app_id\`).

Conventions
- ${conversationIdGuidance}
- \`memoryContext\`: short and task-focused. Kody may use it to surface a few relevant long-term memories for authenticated users and suppress repeats within the same \`conversationId\`.
- Do not ask the user to paste secrets in chat; use saved secrets or \`open_generated_ui\`.
- \`meta_save_skill\`: repeatable workflows only; optional \`collection\`; same name replaces an existing skill. One-off work: \`execute\`. Skill params: pass via \`meta_run_skill\` → \`params\` in codemode.
- \`ui_save_app\` / \`app_id\`: persisted UI artifacts (hidden from search unless \`hidden: false\`). \`codemode.secret_list\` / \`secret_set\`: metadata-only list; set only for values already in trusted execution (see \`execute\` tool description).
- Memory writes are verify-first: always run \`meta_memory_verify\` before \`meta_memory_upsert\` or \`meta_memory_delete\`. Kody retrieves related memories; the consuming agent decides whether to upsert, delete, both, or do nothing. \`meta_memory_upsert\` creates a new memory when \`memory_id\` is omitted and updates an existing memory when \`memory_id\` is provided.
- User-specific MCP instructions: \`meta_get_mcp_server_instructions\` / \`meta_set_mcp_server_instructions\` (signed-in users). Updates apply to **new** MCP sessions (reconnect to refresh what the host shows).

Kody repository (for contributors): https://github.com/kentcdodds/kody

Domains (builtin capability groups)
${domainInstructions}

What shows up in \`search\` (before you search)
- Result **types**: \`capability\` (builtin), \`skill\` (saved codemode), \`app\` (saved UI shell), \`secret\` (metadata only). Use \`entity: "{id}:{type}"\` for one item’s detail.
- **Saved skills** may use an optional **collection** (a user-defined label for grouping). Narrow with \`skill_collection\`; list a user’s collections via \`meta_list_skill_collections\`. Collections are not a closed list—any label when saving or from the user.

search
- \`query\`: natural language; results are ranked (order matters). Optional \`limit\`, \`maxResponseSize\`, \`skill_collection\`.
- \`entity: "{id}:{type}"\` (\`capability\` | \`skill\` | \`app\` | \`secret\`) for one entity’s detail (schemas, usage). If a \`query\` returns no useful hits, rephrase or call \`meta_list_capabilities\` — \`entity\` does not repair an empty ranked list.
- Saved skills/apps need an authenticated user. Examples:
  - search({ query: 'saved dashboard app or generated UI runtime' })
  - search({ query: 'Cloudflare API zones dns workers d1' })
  - search({ entity: 'page_to_markdown:capability' })

execute
- Async arrow function; \`codemode\` + OAuth helpers \`refreshAccessToken\` / \`createAuthenticatedFetch\`. Prefer one \`execute\` when the plan is clear. Full rules for \`fetch\`, placeholders, \`secret_list\` / \`value_get\`, and \`x-kody-secret\`: see the \`execute\` tool description.
- Official how-to guides from the Kody repo: \`kody_official_guide\` with \`guide\` \`oauth\` (standard OAuth, \`/connect/oauth\`) first; \`generated_ui_oauth\` for saved-app OAuth edge cases; \`connect_secret\` for API keys/PATs. If unsure, \`search\` for this capability and load the right guide before implementing.

open_generated_ui
- Exactly one of \`code\` or \`app_id\`. Sensitive input: use UI; import \`kodyWidget\` from \`@kody/ui-utils\`. Details: \`open_generated_ui\` tool description.
	`.trim()
}

export function buildMcpServerInstructions(
	userOverlay: string | null | undefined,
): string {
	const base = buildBaseMcpServerInstructions()
	const trimmed = userOverlay?.trim()
	if (!trimmed) return base
	return `${base}

---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):
${trimmed}`
}
