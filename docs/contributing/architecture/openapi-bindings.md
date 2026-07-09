# OpenAPI provider bindings

Kody can turn a curated slice of an untrusted OpenAPI 3.x document into a
synthesized capability domain. Agents manage bindings through the builtin
`openapi` domain and call resolved operations from execute as
`kody.openapi["<name>"].<operation_slug>(input)`. This complements
[MCP client servers](./mcp-client-servers.md) (`kody.mcp[...]`) and remote
connectors (`kody.remote[...]`): bindings dial out over HTTPS to a pinned API
base, not over MCP.

Agent-facing workflow (discover → summarize → scaffold or bind) lives in
[`docs/guides/openapi-integrations.md`](../../guides/openapi-integrations.md).
Spec summarize and client scaffold helpers live in the `integrations` domain;
binding CRUD and refresh live in `openapi`.

## Storage shape

- Bindings are **user-scoped**, non-secret values-store config keyed
  `_openapi:<name>`.
- Each binding holds: name, `specUrl`, `apiBaseUrl`, an auth reference
  (`integration` | `bearerSecret` | `headerSecret` | `basicSecrets` | `none`), a
  curated selection (`operationIds` / `tags` / `pathPrefixes`),
  `includeDestructive` (default false), and a resolved operation snapshot
  (1..100 operations) produced at save/refresh time.
- Credentials stay in secrets or saved integrations — binding config stores
  names only.

## Synthesis and invocation

- Registry: `getCapabilityRegistryForContext` loads the user's bindings and
  synthesizes an `openapi:<name>` domain per binding (capability per curated
  operation slug), analogous to `mcp:<server>` domains.
- Execute: `kody.openapi["<name>"].<slug>({ params?, query?, headers?, body? })`
  returns `{ status, ok, contentType, body, truncated }`.
- Outbound requests are pinned to the binding's `apiBaseUrl` host.
  Integration-auth requests also enforce the integration host allowlist; secret
  placeholders resolve through the fetch gateway (each secret's `allowedHosts`).
  Integration-auth requests retry once after a token refresh on 401.
- `openapi_binding_refresh` re-fetches the spec, re-applies the stored
  selection, and reports added/removed operations.

## Security invariants

- Specs are untrusted third-party content (bounded HTTPS fetch, no remote
  `$ref`s). Verify URLs against official provider docs.
- Spec `servers` / `suggestedHosts` are suggestions only — they never widen host
  approval. Approval stays in the account security UI and integration
  `requiredHosts`.
- Curate at most 100 operations; never bind a whole large spec. DELETE-method
  operations require `includeDestructive` and remain tagged destructive.

## Key paths

- Shared OpenAPI parse/summarize/auth types: `packages/worker/src/openapi/`
- Binding management capabilities:
  `packages/worker/src/mcp/capabilities/openapi/`
- Synthesized provider domains:
  `packages/worker/src/mcp/capabilities/openapi-provider/`
- Spec summarize / client scaffold (integrations domain):
  `packages/worker/src/mcp/capabilities/integrations/`

## Related docs

- [MCP client servers](./mcp-client-servers.md) — parallel synthesis pattern
- [Adding capabilities](../adding-capabilities.md) — runtime registry merge
- [Primitives map](./primitives.yaml) — `openapi-bindings` primitive
