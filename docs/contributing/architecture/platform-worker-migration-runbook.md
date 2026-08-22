# Platform worker migration runbook

Production already owns the platform Durable Object classes on `kody-platform`.
`transferred_classes` is a one-shot cutover; do not invent a second transfer or
add `deleted_classes` for those names. This page records ownership, the cutover
order that landed, and rollback constraints.

How the remaining platform Durable Objects moved from the origin `kody` Worker
into the `kody-platform` Worker (`packages/platform-worker/`), per
[ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md). The risky step
was the Durable Object **script migration**: the storage of `MCP`,
`McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`,
`RepoSessionIndex`, and `StripePlanRefresh` moved from the `kody` script to the
`kody-platform` script via a Wrangler `transferred_classes` migration.

Later deploys follow `.github/workflows/deploy.yml`. Remix/blog/UI-only uploads
skip platform. Official guide markdown uploads origin and platform.

## Ownership after the split

| Concern                                                                                                                        | Owner                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Remix UI, blog, official guides, static assets                                                                                 | `kody` (origin)                                             |
| MCP HTTP (`/mcp`), OAuth, inbound email, queues                                                                                | `kody` (origin)                                             |
| `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh` | `kody-platform` (origin and runtime bind them cross-script) |
| `StorageRunner`, `RunLog`, `PackageRealtimeSession`                                                                            | `kody-runtime`                                              |
| `JobManager`                                                                                                                   | `kody-jobs`                                                 |
| `APP_DB` / `AUDIT_DB` / KV / R2 / queues / Vectorize / AI                                                                      | Shared resources; each worker binds directly                |

## Migration configuration

Committed in `packages/platform-worker/wrangler.jsonc` (production applies it on
the first `kody-platform` deploy; the exact transfer set is protected by
`tools/ci/durable-object-baseline.json`). The committed `from_script: "kody"` is
rewritten by `tools/ci/platform-worker-config.ts` to the actual deployed origin
script name (`kody-production` — wrangler appends the environment to the
top-level name) at deploy time.

Cloudflare requirements for a `transferred_classes` migration:

- The source script (`kody-production`) must still exist and must still contain
  the migration history that created the classes; the transfer removes them from
  the source script's Durable Object namespace registry.
- The destination script must export classes under the `to` names.
- The source script must stop exporting/serving the classes in the **same
  coordinated deploy window** — after the transfer, DO requests routed through
  the old script's namespaces fail.
- Existing DO ids, storage, and alarms move with the class. In-flight requests
  against the old namespace during the switch can error; run at a quiet time.
- Never add `deleted_classes` for a transferred class. That destroys data.

## Coordinated production deploy order

The merged main-branch deploy workflow (`.github/workflows/deploy.yml`) encodes
this order; the operator's job is to merge and watch, not to run wrangler by
hand.

1. **Preview verification (before merging).** The PR's preview deploy creates a
   fresh worker set (`kody-pr-<n>`, `kody-pr-<n>-platform`,
   `kody-pr-<n>-runtime`). Verify:
   - healthchecks passed (`/health` on origin, `/__platform/health` on platform,
     `/__runtime/health` on runtime);
   - sign-in works and account/mailbox/session surfaces that hit transferred
     Durable Objects load;
   - `GET /mcp` still challenges unauthenticated clients (401). Preview cannot
     rehearse a `transferred_classes` migration (preview sets are created fresh
     with `new_sqlite_classes`). The production transfer already landed; later
     deploys must not invent a second transfer.
2. **Merge the PR.** The production deploy workflow then:
   1. generates the runtime and platform configs from the provisioned origin
      config;
   2. syncs secrets to origin, platform, and runtime;
   3. applies D1 migrations (shared databases, applied once);
   4. **deploys `kody-platform` first** — this applies the `v1`
      `transferred_classes` migration, moving the active classes' storage out of
      `kody`. From this moment the still-running old `kody` deployment serves
      those objects against namespaces that have moved; the window until the
      origin deploy completes must be short. Alarms on `Mailbox`,
      `RepoSessionIndex`, and `StripePlanRefresh` move with the classes;
   5. **deploys `kody-runtime`** with platform bindings retargeted to
      `kody-platform`;
   6. **deploys `kody`** with `script_name: "kody-platform"` on those eight
      classes;
   7. healthchecks origin (`/health`), platform (`/__platform/health`), and
      runtime (`/__runtime/health`), then runs the execute smoke check.
3. **Post-deploy verification.**
   - Sign in and load account, mailbox, and a repo session that existed before
     the cutover (proves old DO storage moved).
   - Hit `/mcp` (OAuth challenge) and confirm an existing MCP session still
     resumes.
   - Check Sentry for origin, platform, and runtime.

Remix/blog/UI-only later deploys upload origin only and skip platform, runtime,
and jobs. Official guide markdown deploys origin and platform (MCP bundles those
files) and still skips runtime and jobs, so those Durable Objects are not reset.
