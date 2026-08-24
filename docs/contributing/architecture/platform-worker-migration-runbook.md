# Platform worker migration runbook

Production owns the platform Durable Object classes on `kody-platform`.
`transferred_classes` is a one-shot cutover; do not invent a second transfer or
add `deleted_classes` for those names.

This page records current ownership and the invariants later deploys must keep.
The cutover that landed is in the
[historical appendix](#historical-appendix-2026-platform-cutover). Do not follow
that appendix as a live playbook.

How the remaining platform Durable Objects live on the `kody-platform` Worker
(`packages/platform-worker/`), per
[ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md). Later deploys
follow `.github/workflows/deploy.yml`. Remix/blog/UI-only uploads skip platform.
Official guide markdown uploads origin and platform.

## Ownership

| Concern                                                                                                                        | Owner                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Remix UI, blog, official guides, static assets                                                                                 | `kody` (origin)                                             |
| MCP HTTP (`/mcp`), OAuth, inbound email, queues                                                                                | `kody` (origin)                                             |
| `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh` | `kody-platform` (origin and runtime bind them cross-script) |
| `StorageRunner`, `RunLog`, `PackageRealtimeSession`                                                                            | `kody-runtime`                                              |
| `JobManager`                                                                                                                   | `kody-jobs`                                                 |
| `APP_DB` / `AUDIT_DB` / KV / R2 / queues / Vectorize / AI                                                                      | Shared resources; each worker binds directly                |

## Invariants

- Do not add another `transferred_classes` row for `MCP`, `McpClientHub`,
  `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`,
  `RepoSessionIndex`, or `StripePlanRefresh`. The `v1` transfer already applied
  on production `kody-platform`. The exact set is protected by
  `tools/ci/durable-object-baseline.json`.
- Never add `deleted_classes` for a transferred class. That destroys data.
- The committed `from_script: "kody"` in
  `packages/platform-worker/wrangler.jsonc` is rewritten by
  `tools/ci/platform-worker-config.ts` to the deployed origin script name
  (`kody-production`) at deploy time. Leave that rewrite in place; do not point
  production at a second source script.
- Preview worker sets (`kody-pr-<n>-platform`) are created fresh with
  `new_sqlite_classes`. Preview cannot rehearse a `transferred_classes`
  migration.
- Cloudflare rules that made the original transfer valid still apply to any
  future class move: the source script must still exist and still contain the
  migration history that created the class; the destination must export the `to`
  names; existing ids, storage, and alarms move with the class. Those rules are
  why a second transfer or a `deleted_classes` tag for these names is forbidden.

## Later deploys

The merged main-branch deploy workflow encodes deploy order. Merge and watch; do
not run wrangler by hand to "finish" a transfer.

When platform sources change, the workflow deploys `kody-platform` before origin
so cross-script bindings stay valid. That order is binding and healthcheck
hygiene. It does not re-apply the `v1` transfer.

Remix/blog/UI-only uploads skip platform, runtime, and jobs. Official guide
markdown deploys origin and platform (MCP bundles those files) and still skips
runtime and jobs, so those Durable Objects are not reset.

Healthchecks: origin `/health`, platform `/__platform/health`, runtime
`/__runtime/health`.

## Historical appendix: 2026 platform cutover

**Do not re-run these steps.** They describe the one-shot script migration that
already landed. Re-issuing `transferred_classes` or adding `deleted_classes` for
the names above destroys or orphans production Durable Object storage.

The storage of `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`,
`Mailbox`, `RepoSession`, `RepoSessionIndex`, and `StripePlanRefresh` moved from
the `kody` script to the `kody-platform` script via a Wrangler
`transferred_classes` migration.

Coordinated order that landed (encoded in `.github/workflows/deploy.yml`):

1. Preview verification on a fresh `kody-pr-<n>` set (healthchecks, sign-in,
   account/mailbox/session surfaces, unauthenticated `GET /mcp` → 401). Preview
   used `new_sqlite_classes`, so it did not rehearse the transfer.
2. Deploy `kody-platform` first — this applied the `v1` `transferred_classes`
   migration. From that moment the still-running old `kody` deployment served
   those objects against namespaces that had moved. Alarms on `Mailbox`,
   `RepoSessionIndex`, and `StripePlanRefresh` moved with the classes.
3. Deploy `kody-runtime` with platform bindings retargeted to `kody-platform`.
4. Deploy `kody` with `script_name: "kody-platform"` on those eight classes.
5. Healthchecks, then execute smoke. Post-deploy checks loaded pre-cutover
   account, mailbox, and repo-session objects and confirmed an existing MCP
   session still resumed.

After the transfer applied, the recovery path was roll _forward_ on
`kody-platform`. A reverse `transferred_classes` migration is a second risky
migration and needs its own reviewed config change; deploy guardrails refuse
unreviewed migration edits.
