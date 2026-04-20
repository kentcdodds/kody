import { builtinDomains } from '#mcp/capabilities/builtin-domains.ts'

const domainInstructions = builtinDomains
	.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
	.join('\n')

export const conversationIdGuidance =
	'The public MCP tools accept optional `conversationId` and `memoryContext` fields. `conversationId` ties related calls together. If you already have a `conversationId` from an earlier response in the same conversation, pass it back unchanged. Otherwise omit this field to receive a server-generated ID, then reuse the returned `conversationId` on subsequent calls - this enables optimizations like reduced response size. Do not invent your own `conversationId`.'

export function buildBaseMcpServerInstructions(): string {
	return `
End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use

Three-step flow:
1. \`search\` — built-in capabilities, saved packages, persisted values, saved connectors, and secret references (metadata).
2. \`execute\` — run one ephemeral module with imports/exports and runtime access through \`kody:runtime\`.
3. \`open_generated_ui\` — open UI when a package or inline UI flow needs user interaction.

Conventions
- ${conversationIdGuidance}
- \`memoryContext\`: short and task-focused. Kody may use it to surface a few relevant long-term memories and suppress repeats within the same \`conversationId\`.
- Do not ask the user to paste secrets in chat; use saved secrets or \`open_generated_ui\`.
- \`package_save\`: create or replace a repo-backed saved package rooted at \`package.json\`. Standard package exports define the package surface. \`package.json#kody\` contains Kody-specific metadata such as tags, optional app config, and package-owned jobs.
- \`package_get\` / \`package_list\` / \`package_delete\`: inspect or manage saved packages for the signed-in user.
- \`job_schedule\`: schedule a repo-backed job for the signed-in user without creating a saved package first. Supports one-off, interval, and cron schedules.
- \`job_schedule_once\`: compatibility wrapper for one-off repo-backed jobs when you only need a single run time.
- \`job_run_now\`: run an existing scheduled job immediately by id and return the updated job view plus execution result for debugging.
- Package jobs are schedules owned by a package. For ad hoc work that is not tied to a package, use \`job_schedule\`. Package apps are optional UI surfaces declared by the package, not a separate top-level primitive.
- Memory writes are verify-first: always run \`meta_memory_verify\` before \`meta_memory_upsert\` or \`meta_memory_delete\`. Kody retrieves related memories; the consuming agent decides whether to upsert, delete, both, or do nothing. \`meta_memory_upsert\` creates a new memory when \`memory_id\` is omitted and updates an existing memory when \`memory_id\` is provided.
- User-specific MCP instructions: \`meta_get_mcp_server_instructions\` / \`meta_set_mcp_server_instructions\` (signed-in users). Updates apply to **new** MCP sessions (reconnect to refresh what the host shows).

Kody repository (for contributors): https://github.com/kentcdodds/kody

Domains (builtin capability groups)
${domainInstructions}

What shows up in \`search\` (before you search)
- Result **types**: \`capability\` (built-in), \`package\` (saved repo-backed package), \`value\` (persisted non-secret config), \`connector\` (saved connector config), \`secret\` (metadata only). Use \`entity: "{id}:{type}"\` for one item’s detail.

search
- \`query\`: natural language; results are ranked (order matters). Optional \`limit\`, \`maxResponseSize\`.
- \`entity: "{id}:{type}"\` (\`capability\` | \`package\` | \`value\` | \`connector\` | \`secret\`) for one entity’s detail (schemas, usage). If a \`query\` returns no useful hits, rephrase or call \`meta_list_capabilities\` — \`entity\` does not repair an empty ranked list.
- Examples:
  - search({ query: 'saved package for github automation' })
  - search({ query: 'Cloudflare API zones dns workers d1' })
  - search({ entity: 'kody_official_guide:capability' })

execute
- Single ESM module string with a default export. Import runtime APIs from \`kody:runtime\`. Prefer one \`execute\` when the plan is clear. Full rules for \`fetch\`, placeholders, \`secret_list\` / \`value_get\`, and \`x-kody-secret\`: see the \`execute\` tool description.
- Cross-package imports use specifiers such as \`kody:@my-package/export-name\`. Package jobs are owned by packages, ad hoc jobs can be scheduled with \`job_schedule\`, and package apps are optional package surfaces.
- Official how-to guides from the Kody repo: if a requested package or workflow depends on a third-party integration, secrets, or OAuth, call \`kody_official_guide\` with \`guide: "integration_bootstrap"\` before building the package. Then load the relevant setup guide: \`oauth\` for standard third-party OAuth (\`/connect/oauth\`), \`connect_secret\` for secret collection, and \`secret_backed_integration\` for the default non-OAuth secret-backed recipe after bootstrap. If unsure, \`search\` for this capability and load the right guide before implementing.
- Do not save or present an auth-dependent package as complete until \`search\` shows the required connector or secret reference exists and a minimal authenticated \`execute\` smoke test succeeds.

open_generated_ui
- Use UI when the package needs user interaction or sensitive input. Details: \`open_generated_ui\` tool description.
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
