import { type CapabilityDomainMetadata } from '#mcp/capabilities/types.ts'

function formatDomainInstructions(
	domains: ReadonlyArray<CapabilityDomainMetadata>,
) {
	return domains
		.map((domain) => `- \`${domain.name}\`: ${domain.description}`)
		.join('\n')
}

const maxRemoteConnectorDescriptionChars = 240

export type RemoteConnectorInstructionSummary = {
	name: string
	domain: string
	description?: string | null
}

function truncateRemoteConnectorDescription(description: string) {
	if (description.length <= maxRemoteConnectorDescriptionChars) {
		return description
	}
	return `${description.slice(0, maxRemoteConnectorDescriptionChars - 3).trimEnd()}...`
}

function formatRemoteConnectorInstructions(
	connectors: ReadonlyArray<RemoteConnectorInstructionSummary> | undefined,
) {
	if (!connectors?.length) return ''
	const lines = connectors.map((connector) => {
		const description = connector.description?.trim()
		return description
			? `- \`${connector.name}\` (\`${connector.domain}\`): ${truncateRemoteConnectorDescription(description)}`
			: `- \`${connector.name}\` (\`${connector.domain}\`)`
	})
	return `

Connected remote connectors
${lines.join('\n')}
`
}

export const conversationIdGuidance =
	'The public MCP tools accept optional `conversationId` and `memoryContext` fields. `conversationId` ties related calls together. If you already have a `conversationId` from an earlier response in the same conversation, pass it back unchanged. Otherwise omit this field to receive a server-generated ID, then reuse the returned `conversationId` on subsequent calls - this enables optimizations like reduced response size. Do not invent your own `conversationId`.'

export function buildBaseMcpServerInstructions(
	input: {
		domains?: ReadonlyArray<CapabilityDomainMetadata>
		remoteConnectors?: ReadonlyArray<RemoteConnectorInstructionSummary>
	} = {},
): string {
	const domainInstructions = formatDomainInstructions(input.domains ?? [])
	return `
End-user documentation (workflows, secrets, troubleshooting):
https://github.com/kentcdodds/kody/tree/main/docs/use

Three-step flow:
1. \`search\` — built-in kody, saved packages, persisted values, saved integrations, and secret references (metadata).
2. \`execute\` — run one ephemeral module with imports/exports and runtime access through \`kody:runtime\`.
3. \`open_generated_ui\` — open saved package apps or inline MCP App workflows.

Conventions
- ${conversationIdGuidance}
- \`memoryContext\`: short and task-focused. Kody may use it to surface a few relevant long-term memories and suppress repeats within the same \`conversationId\`.
- Credential setup uses the standard setup pages: \`/connect/oauth\` for OAuth integrations and reconnects, \`/account/secrets/new\` for API keys, PATs, and other user-provided secrets. Never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat.
- \`package_save\`: create or replace a repo-backed saved package rooted at \`package.json\`. Standard package exports define the package surface. \`package.json#kody\` contains Kody-specific metadata such as tags, optional app config, and package-owned jobs. When creating or materially changing a package, keep a root \`README.md\` \`## Intent\` section with the user's goal; ask the user if unclear and update it when scope expands.
- \`package_get\` / \`package_list\` / \`package_delete\`: inspect or manage saved packages for the signed-in user.
- Integration-backed work: use \`search\` and official guides before local repo exploration. For packages, package apps, or workflows that depend on third-party auth, first call \`coding_guide_get\` with \`guide: "integration_bootstrap"\`, confirm the required \`integration\` or \`secret\` entity exists through \`search\`, run a cheap authenticated \`execute\` smoke test, then build. If setup is missing, load \`oauth\` for \`/connect/oauth\`, \`connect_secret\` for secret collection, and \`secret_backed_integration\` for the default non-OAuth recipe.
- \`job_list\` / \`job_get\`: inspect the signed-in user's scheduled jobs, recent run outcomes, and current per-user alarm state when debugging scheduling issues. Pass \`includeCode: true\` to \`job_get\` when you need the stored repo-backed job source entrypoint and code.
- \`job_schedule\`: schedule a repo-backed job for the signed-in user without creating a saved package first. Supports one-off, interval, and cron schedules.
- \`job_schedule_once\`: compatibility wrapper for one-off repo-backed jobs when you only need a single run time.
- \`job_update\`: update an existing scheduled job by id. Supports safe mutable fields such as name, code, params, schedule, timezone, enabled, and kill-switch state. Providing \`code\` publishes a new commit on the job's repo-backed source (the simplest way to change the job module for non-package jobs); the replacement must default export a function and read \`params\` from its first argument, not from \`kody:runtime\`.
- \`job_delete\`: delete one of the signed-in user's scheduled jobs by id.
- \`job_run_now\`: run an existing scheduled job immediately by id and return the updated job view plus execution result for debugging.
- \`workflow_run_list\`: inspect recent Cloudflare Workflow runs created through \`kody:runtime\` \`workflows.create\`; use it after durable long-running work such as batch sweeps, migrations, and polling loops.
- Package jobs are schedules owned by a package. For ad hoc work that is not tied to a package, use \`job_schedule\`. Package apps are optional UI surfaces declared by the package, and packages may also declare headless package services for long-lived background runtimes.
- Package apps can also use Kody-managed realtime websocket sessions through \`session_list\`, \`session_emit\`, and \`session_broadcast\`, and package jobs can emit to those sessions when running under the same package caller context.
- Package services are inspected and controlled through \`service_list\`, \`service_get\`, \`service_start\`, and \`service_stop\`.
- Memory writes are verify-first: always run \`meta_memory_verify\` before \`meta_memory_upsert\` or \`meta_memory_delete\`. Kody retrieves related memories; the consuming agent decides whether to upsert, delete, both, or do nothing. \`meta_memory_upsert\` creates a new memory when \`memory_id\` is omitted and updates an existing memory when \`memory_id\` is provided.
- User-specific MCP instructions: \`meta_get_mcp_server_instructions\` / \`meta_set_mcp_server_instructions\` (signed-in users). Updates apply to **new** MCP sessions (reconnect to refresh what the host shows).
- Kody friction: when capabilities, packages, memories, or guides create avoidable friction, call \`coding_guide_get\` with \`guide: "platform_friction"\`; mention the friction to the user, ask before memory changes, and make obvious local docs/package improvements when already in scope.

Kody repository (for contributors): https://github.com/kentcdodds/kody

Domains (builtin capability groups)
${domainInstructions}
${formatRemoteConnectorInstructions(input.remoteConnectors)}

What shows up in \`search\` (before you search)
- Result **types**: \`capability\` (built-in or connected remote connector), \`package\` (saved repo-backed package), \`value\` (persisted non-secret config), \`integration\` (saved integration config), \`secret\` (metadata only). Use \`entity: "{id}:{type}"\` for one item’s detail.

search
- \`query\`: natural language; results are ranked (order matters). Optional \`limit\`, \`maxResponseSize\`.
- \`entity: "{id}:{type}"\` (\`capability\` | \`package\` | \`value\` | \`integration\` | \`secret\`) for one entity’s detail. Capability detail includes an exact execute snippet and TypeScript call shapes; other entity details include usage. If a \`query\` returns no useful hits, rephrase or call \`meta_list_capabilities\` — \`entity\` does not repair an empty ranked list.
- Examples:
  - search({ query: 'saved package for github automation' })
  - search({ query: 'Cloudflare API zones dns workers d1' })
  - search({ entity: 'coding_guide_get:capability' })

execute
- Single ESM module string with a default export such as \`export default async function main(input = {}) { ... }\`; \`params\` are passed as the first argument. Import runtime APIs from \`kody:runtime\`. Example: \`import { kody, refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials, secretHeaders, workflows } from 'kody:runtime'\`. Built-in capabilities returned by \`search\` are available through \`kody\`: use \`await kody.capability_id(input)\` for valid identifier names or \`await kody["capability-id"](input)\` for non-identifier ids. Remote connector capabilities are deliberately separate: use \`await kody.remote["name"].capability_name(input)\` (for example \`kody.remote["home"].set_pin({ pin })\`), never a flat \`kody.kind_instance_capability(...)\` call. \`workflows.create\` can queue inline \`code\` or a saved-package \`exportName\`; prefer it for durable, retryable, inspectable work that may outlive execute's timeout, while plain execute is for quick single operations. Use \`secretHeaders.basic(...)\` or \`oauthClientCredentials(...)\` for client-credentials Basic Auth instead of asking users to precompute a Basic header. Prefer one \`execute\` when the plan is clear. Full rules for \`fetch\`, placeholders, \`secret_list\` / \`value_get\`, and \`x-kody-secret\`: see the \`execute\` tool description.
- Cross-package imports use specifiers such as \`kody:@scope/my-package/export-name\`. For dynamic current-version calls inside package runtime code or authenticated execute calls, prefer \`packages.invokeChecked({ kodyId, exportName, params })\` or \`packages.check(...)\` followed by \`packages.invoke(check.invoke)\`; use static imports for library-like bundled snapshots. Saved package names must be scoped (\`@scope/<leaf>\`) and the leaf segment must match \`kody.id\`. Package jobs are owned by packages, ad hoc jobs can be scheduled with \`job_schedule\`, and package apps are optional package surfaces.
- Official how-to guides from the Kody repo: when creating or materially changing a package, call \`coding_guide_get\` with \`guide: "package_authoring"\`. If the package, package app, or workflow depends on a third-party integration, secrets, or OAuth, call \`guide: "integration_bootstrap"\` before building the dependent package. If unsure, \`search\` for this capability and load the right guide before implementing.
- Do not save or present an auth-dependent package as complete until \`search\` shows the required integration or secret reference exists and a minimal authenticated \`execute\` smoke test succeeds.

open_generated_ui
- Opens saved package apps and inline MCP App workflows. Details: \`open_generated_ui\` tool description.
	`.trim()
}

export function buildMcpServerInstructions(
	input:
		| string
		| null
		| undefined
		| {
				userOverlay?: string | null | undefined
				domains?: ReadonlyArray<CapabilityDomainMetadata>
				remoteConnectors?: ReadonlyArray<RemoteConnectorInstructionSummary>
		  },
): string {
	const normalizedInput =
		typeof input === 'object' && input !== null ? input : { userOverlay: input }
	const base = buildBaseMcpServerInstructions({
		domains: normalizedInput.domains,
		remoteConnectors: normalizedInput.remoteConnectors,
	})
	const userOverlay = normalizedInput.userOverlay
	const trimmed = userOverlay?.trim()
	if (!trimmed) return base
	return `${base}

---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):
${trimmed}`
}
