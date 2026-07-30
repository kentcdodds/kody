export const executeToolOverviewDescription = `Run one ephemeral ESM module string with a default export. Imports may be arbitrary npm packages compatible with the Cloudflare Workers runtime (e.g. \`p-retry\`, \`mailparser\`, \`remark\`); prefer existing packages over rewriting helpers. Discover capability names with \`search\`; for one capability’s executable snippet and TypeScript call shape, call \`search\` with \`entity: "{name}:capability"\` or use \`meta_list_capabilities\`.`

export const executeToolProjectionRuleDescription = `Projection rule: you write the code -- if a call returns a large response, project the fields you need before returning. Never return raw API responses; extract a slim shape (e.g. \`{ id, subject, snippet }\`) or a summary.`

export const executeToolSandboxSurfaceDescription = `Sandbox surface:
- Import runtime helpers from \`kody:runtime\`.
- \`import { kody } from 'kody:runtime'\` for builtin capabilities discovered by \`search\`; call valid identifier names as \`await kody.capability_id(input)\`. If a capability id is not a valid JavaScript identifier, use bracket notation: \`await kody["capability-id"](input)\`. Capability detail from \`search({ entity: "{name}:capability" })\` includes the exact snippet.
- Remote connector, user-added MCP server, and curated OpenAPI capabilities use namespaced accessors: \`await kody.remote["name"].capability_name(input)\`, \`await kody.mcp["server-name"].tool_name(input)\`, and \`await kody.openapi["name"].operation_slug(input)\` — never a flat \`kody.kind_instance_capability(...)\` call.
- Storage, one rule per context: ad hoc execute code uses \`import { storage } from 'kody:runtime'\` against the \`storageId\` bound to the call; saved-package code always uses \`packageStorage()\` from 'kody:runtime' for the package's own data (package repo checks fail on ambient \`storage\` imports); another package's data goes through keyless \`packages.invoke\` so its own runtime does the reading and writing.
- \`storage\` exposes \`get\`/\`set\`/\`list\`/\`delete\`/\`clear\` and \`storage.sql(query, params?)\`, which returns \`{ columns, rows, rowCount, rowsRead, rowsWritten }\`; read query rows from \`.rows\`. It is \`undefined\` when the call binds no \`storageId\`, and always \`undefined\` in saved-package invocation runs, which bind no ambient storage.
- \`packageStorage()\` returns the same storage interface bound to the declaring package's own bucket, in the package's own runtime and when the module is statically imported (\`kody:@scope/package/export\`) into an execute call or another package — no \`storageId\` needed. Inline execute code has no package provenance, so \`packageStorage()\` throws there.
- \`import { refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials, secretHeaders } from 'kody:runtime'\` for OAuth integrations and secret-derived auth headers. Integration \`name\` may be account-specific (e.g. \`google-personal\`, \`google-business\`); call \`integration_list\` first when a provider may have multiple accounts connected. For client-credentials Basic Auth, save the id and secret separately and use \`secretHeaders.basic({ usernameSecret, passwordSecret, scope })\` in the Authorization header, or \`oauthClientCredentials(...)\` for the token request; do not ask users to precompute a derived Basic header.
- \`import { workflows } from 'kody:runtime'\` for durable Cloudflare Workflows. \`workflows.create\` accepts either inline \`code\` or a saved-package \`exportName\`; use \`workflow_run_list\` to inspect recent runs.
- Execute has a hard timeout (~90s by default). For batch sweeps, migrations, polling loops, or work likely to run >~60s, submit one durable \`workflows.create({ code, params })\` from a single execute call instead of chaining many MCP round-trips.
- Optional \`params\` are passed as the first argument to the module default export. Prefer \`export default async function main(input = {}) { ... }\`; pass \`input\` to shared helpers explicitly.
- \`import { packageContext } from 'kody:runtime'\` in saved package code when you need package metadata; it is \`null\` for ad hoc execute calls.
- Package reuse, two rules. (1) Target package name known when the code is written → static import: \`import fn from 'kody:@scope/my-package/export-name'\` (npm-scoped package name). This is the default from execute and from other packages: typed, publish-verified, dependency-graph-visible, zero per-call platform cost. Ad hoc execute bundles per call, so static imports from execute always see the current published version. (2) Target name is data, the call needs the target package's own runtime (\`packageContext\`, \`kody.secretMounts\` package secrets, its own \`packageStorage()\` bucket), or you need exactly-once → \`import { packages } from 'kody:runtime'\` and \`packages.invoke({ kodyId: 'github', exportName, params })\`, the only dynamic call, always contract-checked before invoking. \`kodyId\` is the bare Kody id (for example \`github\`), not the npm-scoped name. Keyless invoke is lean/ephemeral (current published version, run records on failure only); add the optional \`idempotencyKey\` field only for exactly-once needs such as webhook event ids and retried dispatch. \`packages.invokeChecked\`, \`packages.check\`, and literal dynamic \`import("kody:@...")\` were removed and throw errors naming the replacement.
- \`fetch(...)\` is the host-provided network global; \`{{secret:name}}\` / \`{{secret:name|scope=user}}\` work in URL, headers, or body on approved hosts only. \`secretHeaders.basic(...)\` returns an opaque placeholder for fetch headers; the gateway resolves both referenced secrets, enforces host approval for both, and sends only the derived Basic header. For host approval failures, use the error’s approval path.
- Fields marked \`x-kody-secret: true\` accept the same placeholder form; respect per-secret allowed-capability lists.
- Placeholders are not general string interpolation (they do not resolve in arbitrary return values). Never place placeholder text into user-visible or third-party-visible content such as issue bodies, comments, prompts, logs, or returned strings; obfuscate the \`{{secret:...}}\` token if you must describe it literally.
- \`await kody.secret_list({ scope? })\` — metadata only. \`secret_set\` / \`secret_set_many\` — persist values already in trusted execution (e.g. refreshed tokens); write-only. OAuth refresh uses \`secret_set_many\` so rotating refresh+access tokens commit together after an assert-only grant check. No \`secret_get\` / \`secrets\` helpers in the sandbox.
- \`value_get\` / \`value_list\` for non-secret persisted config.`

export const executeToolIdempotencyDescription = `Optional \`idempotencyKey\` (max 256 chars): when set, Kody persists the run eagerly (including successes) with a bounded result snapshot under the run record. If the MCP client times out (-32001) while the sandbox continues, retry with the same key to get \`replayed: true\` plus the retained result and \`runId\`, or an \`inProgress: true\` response with \`runId\` while still running — neither re-executes. Poll \`run_get\` with that \`runId\`. Key-less execute stays on-failure-only (successes are not listed in Activity).`

export const executeToolCallPlanningDescription = `Prefer one \`execute\` when the workflow is clear; split calls when you need new user input or a changed plan.`

export const executeToolExampleDescription = `Example:

\`import { kody } from 'kody:runtime'

export default async function main(input = {}) {
  void input;
  return await kody.coding_guide_get({
    guide: 'integration_bootstrap',
  });
}\``

export const executeToolRawContentDescription =
	'To return non-text MCP content blocks (e.g. images), see: https://github.com/kentcdodds/kody/blob/main/docs/use/raw-content-blocks.md'

export const executeToolMoreContextDescription =
	'More context: https://github.com/kentcdodds/kody/blob/main/docs/use/execute.md'

export const executeToolDescriptionFragments = [
	executeToolOverviewDescription,
	executeToolProjectionRuleDescription,
	executeToolSandboxSurfaceDescription,
	executeToolIdempotencyDescription,
	executeToolCallPlanningDescription,
	executeToolExampleDescription,
	executeToolRawContentDescription,
	executeToolMoreContextDescription,
] as const

export const executeToolDescription =
	executeToolDescriptionFragments.join('\n\n')
