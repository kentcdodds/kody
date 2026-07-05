# Capability and primitive migration-risk audit (2026-07)

Kody is still early enough that compatibility mistakes can be fixed cheaply.
This audit ranks the surfaces that will become expensive once real users have
saved packages, jobs, secrets, memories, connector settings, package imports,
and Durable Object state that reference today's identifiers and shapes.

## Scope and evidence

Reviewed:

- Capability registry code under `packages/worker/src/mcp/capabilities/`.
- Synthesized remote connector capabilities in
  `packages/worker/src/mcp/capabilities/remote-connector/index.ts` and
  `packages/worker/src/remote-connector/remote-domain-id.ts`.
- Account export capability/domain code in
  `packages/worker/src/mcp/capabilities/account/` and
  `packages/worker/src/app/account-export.ts`.
- D1 migrations through `packages/worker/migrations/0049-audit-events.sql`.
- Durable Object, KV, Vectorize, entity-source, and package import code under
  `packages/worker/src/`.
- Architecture docs, especially `adding-kody.md`, `data-storage.md`, and
  `primitives.yaml`.

## Findings by migration risk

### Critical: capability names and output fields are already user-data contracts

**Evidence**

- Names are keyed globally in
  `packages/worker/src/mcp/capabilities/build-capability-registry.ts`.
- Secret policy allowlists persist capability names in
  `secret_entries.allowed_capabilities`
  (`packages/worker/migrations/0010-secret-allowed-kody.sql`).
- Kody runtime exposes capabilities as `kody.<capabilityName>()` in
  `packages/worker/src/mcp/run-kody-registry.ts`.
- `meta_list_capabilities` returns TypeScript call shapes from
  `packages/worker/src/mcp/capabilities/meta/meta-list-kody.ts`.

**Blast radius**

Renaming a capability breaks saved jobs/packages, user MCP instructions,
memories that mention capability ids, and secret allowlists. Renaming an output
field breaks saved code that destructures results.

**Recommendation: fix now**

Kent is currently the only user, so this PR intentionally does **not** add
alias/deprecation machinery. Bad identifiers should be fixed directly now, and
Kent can manually update saved packages, jobs, memories, and secret allowlists
from the PR migration punch list.

This PR documents the later compatibility policy in
`docs/contributing/adding-kody.md`: additive-only inputs, never-remove outputs,
and an explicit compatibility plan before open signup.

### Critical: remote connector capability names are dynamic and unvalidated

**Evidence**

- Names were synthesized as a flat
  `remoteConnectorCapabilityPrefix(ref) + "_" + sanitizedToolName` in
  `packages/worker/src/mcp/capabilities/remote-connector/index.ts`.
- Domain ids are `remote:{kind}:{instanceSlug}` in
  `packages/worker/src/remote-connector/remote-domain-id.ts`.
- Connector `inputSchema`, `outputSchema`, descriptions, keywords, and
  annotations pass through from connector snapshots in
  `remote-connector/index.ts`.
- The old shape produced double-prefix names such as
  `roku_default_roku_press_key`.

**Blast radius**

A connector tool rename changes the capability name and breaks saved code,
secret allowlists, memory references, and user instructions. Connector-provided
descriptions and keywords enter search text verbatim. Connector-provided
annotations may cause hosts to treat side-effecting remote actions as safer than
they are.

**Recommendation: fix now**

This PR makes the breaking change now:

- Remote capability entity ids are `remote:<name>:<tool>`.
- Built-ins remain flat on the kody object (`kody.value_get(...)`).
- Remote capabilities move to `kody.remote["<name>"].<tool>(input)` and
  disappear from flat `kody.<kind>_<instance>_<tool>` calls.
- Connector names are explicit user-chosen names, validated as lowercase
  alphanumeric plus dashes, and globally unique per user. `kind` remains
  connector protocol metadata, but does not key the runtime namespace. This
  keeps the common single-connector case clean (`kody.remote["home"]`) and makes
  Proxy error messages shorter.
- First-class provenance metadata (`source: 'builtin' | 'remote-connector'`,
  connector name, and clean tool name) is surfaced in `meta_list_capabilities`,
  capability search rows, capability detail structured output, and MCP logs.

Renaming an existing connector name changes the
`userScopedConnectorSessionKey(userId, kind, instanceId)` Durable Object id.
This can orphan the old live session snapshot, but connector sessions rebuild
from settings and the remote connector reconnect handshake; no persisted user
content is stored only in that session. Reconnect the connector after renaming.
Reindex capability vectors if old remote capability ids were indexed.

Follow up before open signup with connector-author guidance and possibly a
connector lint/check for tool names and schemas. After open signup, do not
change remote id or capabilities namespace rules without a migration plan.

### High: D1 JSON blobs are shadow schemas

**Evidence**

- `jobs.*_json` columns in `0018-jobs.sql`, `0025-jobs-repo-check-policy.sql`,
  and `packages/worker/src/jobs/repo.ts`.
- `published_bundle_artifacts.dependencies_json` in
  `0028-published-bundle-artifacts-and-archived-jobs.sql`, queried with SQLite
  JSON functions in
  `packages/worker/src/repo/published-bundle-artifacts-repo.ts`.
- `package_invocations.*_json` in `0029-package-invocations.sql`.
- Email JSON metadata in `0030-email-primitives.sql` and
  `0031-unified-email-receipt.sql`.
- Secret policy arrays in `0009-secret-allowed-hosts.sql`,
  `0010-secret-allowed-kody.sql`, and `0023-secret-allowed-packages.sql`.
- Runtime debug JSON in `0037-package-runtime-debug.sql`.
- Account export sections in `packages/worker/src/app/account-export.ts` mirror
  the account-deletion inventory and read D1, Durable Object, KV, and Vectorize
  surfaces through explicit section schemas in
  `packages/worker/src/mcp/capabilities/account/account-export-shared.ts`.

**Blast radius**

Changing these shapes without tolerant readers or backfills can break job
execution, package dependency scanning, email display, secret authorization,
debug UI, and account deletion.

**Recommendation: fix before open signup**

This PR documents every audited JSON shadow schema in `data-storage.md`. Follow
up with versioning/validation decisions for the riskiest blobs:
`jobs.caller_context_json`, `jobs.schedule_json`,
`published_bundle_artifacts.dependencies_json`, and secret policy arrays.

### High: Durable Object idFromName schemes are permanent

**Evidence**

- `JobManager`: `packages/worker/src/jobs/manager-client.ts`.
- `StorageRunner`: `packages/worker/src/storage-runner.ts`.
- `RepoSession`: `packages/worker/src/repo/repo-session-rpc.ts`.
- `PackageRealtimeSession`:
  `packages/worker/src/package-runtime/realtime-session.ts`.
- `PackageServiceInstance`:
  `packages/worker/src/package-runtime/package-service.ts`.
- `RemoteConnectorSession`: `packages/worker/src/remote-connector/client.ts` and
  `packages/worker/src/remote-connector/connector-session-key.ts`.
- MCP object keying is SDK session based in `packages/worker/src/mcp/index.ts`.

**Blast radius**

Changing an id string or tuple layout creates a new Durable Object and strands
existing storage, alarms, WebSocket sessions, or package service state.

**Recommendation: acceptable with documentation**

Current schemes are deliberate and mostly user-scoped. `RepoSession` and MCP are
not user-prefixed, but enforce user ownership at request/RPC boundaries. This PR
records the schemes as frozen contracts in `data-storage.md`.

### High: unbounded growth tables need retention stories

**Evidence**

- `audit_events` is append-only in
  `packages/worker/migrations/0049-audit-events.sql` and
  `packages/worker/src/app/audit-log.ts`.
- Email tables are defined in `0030-email-primitives.sql` and `0031`.
- `package_runtime_runs` and `package_runtime_logs` are defined in
  `0037-package-runtime-debug.sql`.
- `workflow_runs` is defined in `0035-workflow-runs.sql`.
- `package_invocations` is defined in `0029-package-invocations.sql`.
- Published bundle artifacts and KV snapshots accumulate across publishes in
  `packages/worker/src/package-runtime/published-bundle-artifacts.ts`.

**Blast radius**

Unbounded per-user or global rows increase cost, slow account deletion, and make
future migrations more expensive.

**Recommendation: fix before open signup**

This PR documents the retention watch list in `data-storage.md`. Follow up with
explicit retention policy and pruning jobs for audit events, email, runtime
debug logs, workflow projections, package invocations, and old KV artifacts.

### Medium: capability naming conventions are inconsistent

**Evidence**

- Built-in names include intentionally short meta names (`search`, `execute`)
  plus domain-prefixed names (`package_get`, `repo_write_file`).
- This PR directly renamed the obvious outliers: `package_subscription_list` ->
  `package_subscriptions_list`, `workflow_list` -> `workflow_run_list`,
  `jwt_sign` -> `secret_jwt_sign`, and `kody_official_guide` ->
  `coding_guide_get`.
- This PR also changes `secret_jwt_sign` inputs from camelCase to snake_case:
  `privateKeySecretName` -> `private_key_secret_name`, `privateKeySecretScope`
  -> `private_key_secret_scope`, and `privateKeyJsonField` ->
  `private_key_json_field`.
- `capabilityDomainNames.math` exists in
  `packages/worker/src/mcp/capabilities/domain-metadata.ts` but no math domain
  is registered in `builtin-domains.ts`.
- Payload casing varies: many domains use snake_case, while `execute` and search
  use camelCase fields such as `conversationId`, `storageId`, and
  `errorDetails`.

**Blast radius**

The blast radius is high if names or fields are renamed, but medium if treated
as compatibility debt and documented.

**Recommendation: fix now**

This PR fixes the obvious bad names directly while Kent is the only user. The
remaining naming policy is documented for future additions.

Follow up: decide whether to keep or remove the dead `math` domain constant
before external docs mention it.

### Medium: `meta_list_capabilities` domain filtering was incomplete

**Evidence**

- The old input schema in
  `packages/worker/src/mcp/capabilities/meta/meta-list-kody.ts` only allowed
  `admin`, `apps`, `community`, `coding`, `jobs`, `math`, and `meta`. It omitted
  packages, repo, secrets, services, storage, values, email, integrations, and
  `remote:*` domains.

**Blast radius**

Agents could not ask for exact registry detail for most domains, which pushes
them toward search guesses and makes compatibility audits harder.

**Recommendation: fix now**

This PR changes the filter to a non-empty string and documents that it accepts
built-in domains and synthesized remote connector domains.

### Medium: structured entitlement errors were lost at execute boundaries

**Evidence**

- Typed entitlement errors live in `packages/worker/src/entitlements/errors.ts`.
- `packages/worker/src/mcp/executor.ts` previously mapped secret, host approval,
  and auth errors into `ExecutionErrorDetails`, but not entitlement errors.

**Blast radius**

Saved packages and agents could only see entitlement denial text, not the stable
`code`, `resource`, `plan`, `limit`, and `current` fields.

**Recommendation: fix now**

This PR maps `EntitlementLimitError` to `kind: 'entitlement_limit_exceeded'`
with structured details and a suggested action.

### Medium: KV and Vectorize formats were under-documented

**Evidence**

- KV key builders live in
  `packages/worker/src/package-runtime/published-runtime-artifacts.ts`,
  `packages/worker/src/package-runtime/published-bundle-artifacts.ts`,
  `packages/worker/src/community/snapshot.ts`, and
  `packages/worker/src/package-retrievers/manifest-cache.ts`.
- Vector ids and metadata live in
  `packages/worker/src/mcp/memory/memory-vectorize.ts`,
  `packages/worker/src/mcp/jobs-vectorize.ts`,
  `packages/worker/src/package-registry/vectorize.ts`, and
  `packages/worker/src/mcp/capabilities/capability-reindex.ts`.

**Blast radius**

Changing key grammar or metadata fields without reindex/delete coverage creates
orphaned KV entries, missed account deletion cleanup, or stale search results.

**Recommendation: acceptable with documentation**

This PR documents the current formats in `data-storage.md`. Follow up with a
Vectorize metadata reindex playbook and KV cleanup policy for old publish
artifacts.

### Medium: `primitives.yaml` lagged recent platform changes

**Evidence**

- Admin MCP domain exists in
  `packages/worker/src/mcp/capabilities/admin/domain.ts` and admin routes in
  `packages/worker/src/app/handlers/admin-*.ts`.
- Entitlement daily counters are in
  `packages/worker/migrations/0048-user-plans-and-entitlement-counters.sql`.
- Remote connector settings are in
  `packages/worker/migrations/0034-remote-connector-settings.sql` and account UI
  handlers.
- Cron branch cleanup runs from `packages/worker/src/index.ts`.

**Blast radius**

Reviewers and recap tooling misclassify future changes, causing under-review of
auth, storage, and admin surfaces.

**Recommendation: fix now**

This PR updates `primitives.yaml` for admin/RBAC, entitlements counters, usage
metering vs enforcement, remote connector settings/UI, cron reality, expanded D1
scope, and Bundle Artifacts KV.

### Low: package import resolution is stable but should be treated as frozen

**Evidence**

- Parser: `packages/worker/src/package-runtime/package-import-resolution.ts`.
- Export normalization: `packages/worker/src/package-registry/manifest.ts`.
- Static/dynamic handling:
  `packages/worker/src/package-runtime/module-graph.ts`.
- Import string builder:
  `packages/worker/src/package-registry/package-import-specifier.ts`.

**Blast radius**

Saved packages import each other with persisted `kody:@scope/name/export`
strings. Grammar changes break user code.

**Recommendation: acceptable with documentation**

This PR documents the grammar and static/dynamic distinction in
`data-storage.md`.

## Safe mechanical fixes in this PR

- Added capability source metadata and remote connector provenance to capability
  types, registry specs, `meta_list_capabilities`, search result structures, and
  MCP capability logs.
- Changed remote connector capability ids to `remote:<name>:<tool>` and moved
  execute/runtime calls to `kody.remote["<name>"].<tool>(input)`.
- Folded the new account export capability domain into the audit and primitive
  map; `account_export_manifest` and `account_export_section` are read-only and
  explicitly avoid secret values.
- Fixed `meta_list_capabilities` domain filtering to accept all built-in and
  synthesized remote domains.
- Added structured execute error details for `EntitlementLimitError`.
- Updated compatibility/versioning docs in `adding-kody.md`.
- Documented D1 JSON shadow schemas, Durable Object keys, KV keys, Vectorize
  metadata, `entity_sources`, package import grammar, and retention watch-list
  items in `data-storage.md`.
- Updated `primitives.yaml` for recent admin, invite, entitlement, metering,
  remote connector, cron, and storage changes.

## Follow-up list requiring migration or design discussion

Do not bundle these into mechanical cleanups:

1. Decide whether any remaining built-in capability name is unacceptable forever
   and rename it directly before open signup while Kent is still the only user.
2. Define the post-cleanup compatibility policy to adopt before real users exist
   (deprecation windows, migration notes, and whether any future alias/shim
   machinery is warranted).
3. Add connector-author compatibility checks for remote tool names, schemas,
   annotations, and duplicate prefixes.
4. Decide whether remote connector raw JSON Schemas should be validated by Kody,
   and how to handle schemas that Zod or the current runtime cannot represent.
5. Add version/tolerant-reader policies for D1 JSON blobs, especially jobs,
   published bundle dependencies, package invocations, email metadata, and
   secret policy arrays.
6. Decide whether secret policy parse errors should fail closed instead of
   normalizing to an empty list.
7. Add retention/pruning for `audit_events`, email rows, package runtime logs,
   workflow rows, package invocation rows, and stale bundle/retriever KV keys.
8. Decide whether `audit_events` needs a nullable `user_id` plus index before
   per-user audit/export features depend on it.
9. Add a Vectorize metadata version/reindex playbook for future metadata shape
   changes.
10. Decide whether to remove the stale `math` domain constant or reserve it as a
    documented future domain.
11. Consider targeted indexes only after product queries exist:
    `package_runtime_logs(user_id)`, community owner/rater/forker lookup
    indexes, and any future per-user audit-event index.
12. Keep the dual user id model documented until a deliberate migration can
    unify INTEGER auth ids and TEXT MCP user ids.
