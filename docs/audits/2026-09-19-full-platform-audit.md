# Full platform audit — 2026-09-19

Point-in-time review of `kentcdodds/kody` at `13f5efa9` (`main`). This is an
audit record, not a change list. No production metrics, dollar totals, or
traffic volumes are invented. Numbers below are either in source or in a cited
doc. Secrets are not quoted.

**Scope.** Packages, workers, Durable Objects, MCP search/execute, Vectorize,
Jev, feature flags, billing, admin, docs, and a sample of hot paths. Onboarding
funnel _implementation_ is out of scope (another change owns it). Funnel
observability is one short note under Observability.

**Relation to the 2026-09-16 audit.** That review
([`2026-09-16-codebase-audit.md`](./2026-09-16-codebase-audit.md)) covered
security, accessibility, and a few performance items, and shipped a background
gate on `communityForkAdopt`. This review re-read those claims. They are not
re-argued at the same length. Accepted residuals in
[`docs/contributing/security.md`](../contributing/security.md) are not reopened.

## Method

Read the architecture index, project intent, security invariants, and the
primitives map, then inspected worker entrypoints, capability access control,
secret authority, jobs, billing, status probes, entitlements, and community
admin. Hot paths sampled: MCP search rate limit, `execute` heartbeat,
`StorageRunner.sqlQuery`, scheduled job claim/finalize, job delete vs vector
delete, integration usage mode, and background caller identity.

Not covered: live Cloudflare dashboards, WAF, dependency CVE scoring, a browser
accessibility pass, load tests, or Stripe account settings outside the repo.

Severity:

| Level | Meaning                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| P0    | Remote unauthenticated takeover, or a cross-user data read/write                                                                     |
| P1    | Same-user secret or third-party-account compromise from untrusted package code, or an unbounded customer/operator bill on a hot path |
| P2    | Real defect with a bounded blast radius, or a product decision that is inconsistent with a nearby consent gate                       |
| P3    | Defense in depth, docs drift, or a papercut                                                                                          |

No P0 showed up in the paths checked.

## Executive summary

Kody's isolation model holds. Person accounts cannot be delegated, vector search
is partitioned by user, first-party secrets are purpose-bound, and origin owns
no Durable Object classes in steady-state production. The risks that matter are
consent gaps on the _operator's own_ account and on third-party connections,
plus a few unbounded cost paths.

| #   | ID  | Sev | Risk or opportunity                                                                                                                        | Needs Kent?                        |
| --- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 1   | S1  | P1  | Background package runs load admin roles, so a job, webhook, or `packages.invoke` on an admin-owned package can call admin MCP             | Yes                                |
| 2   | S2  | P1  | New OAuth connections and remote MCP servers default to `usage_mode = any`, so every package can use them without the secret-adoption gate | Yes                                |
| 3   | S3  | P1  | The sandbox secret-authority runner is still a `Symbol.for` property (2026-09-16 H2)                                                       | No                                 |
| 4   | C1  | P1  | `StorageRunner.sqlQuery` still materializes the full cursor (2026-09-16 H3)                                                                | Only if unbounded SQL is a promise |
| 5   | S4  | P2  | The sandbox `kody.*` map still includes consent-sensitive capabilities, including interactive `communityForkAdopt`                         | Yes                                |
| 6   | R1  | P2  | A non-transient scheduled-job throw aborts the user's due batch; transient retries have no ceiling                                         | Yes, for "give up"                 |
| 7   | R2  | P2  | Deleting a job removes the row before the vector, so a failed delete orphans search                                                        | No                                 |
| 8   | O1  | P2  | Public status stays green if Vectorize, AI/Jev, queues, or the platform worker are down                                                    | Yes, for what pages                |
| 9   | C2  | P2  | Platform `RepoSession` still statically imports `isomorphic-git`; origin SSR still statically imports `marked`                             | No                                 |
| 10  | U1  | P2  | Community bans have no reachable unban                                                                                                     | Yes, for unban                     |

Do not shard Vectorize, add a third public MCP tool, or reopen open Dynamic
Client Registration, CSRF-token absence, or sandbox SSRF. Those are decided or
documented residuals.

## Severity index

| ID  | Sev | Area          | Title                                                                                               |
| --- | --- | ------------- | --------------------------------------------------------------------------------------------------- |
| S1  | P1  | security      | Admin role on background package callers                                                            |
| S2  | P1  | security      | Default `usage_mode` `any` for integrations and remote MCP                                          |
| S3  | P1  | security      | Secret-authority runner reachable via well-known symbols                                            |
| C1  | P1  | cost          | Unbounded package SQL                                                                               |
| S4  | P2  | security      | Consent-sensitive capabilities stay on the sandbox map                                              |
| S5  | P2  | security      | Hub MCP tokens are not the secret-store cipher                                                      |
| S6  | P2  | security      | `integrationSave` create skips the host-approval check                                              |
| R1  | P2  | reliability   | Scheduled-job claims retry forever or abort the batch                                               |
| R2  | P2  | reliability   | Job delete drops the row before the vector                                                          |
| C2  | P2  | cost          | Eager `isomorphic-git` and `marked`                                                                 |
| C3  | P2  | cost          | Authenticated search awaits D1 writes                                                               |
| C4  | P2  | cost          | Jev and embeddings are operator-paid, with no user meter                                            |
| C5  | P2  | cost          | Mailbox list selects full bodies and uses OFFSET                                                    |
| O1  | P2  | observability | Status and probes miss the quiet failures                                                           |
| U1  | P2  | product       | Community unban is unreachable                                                                      |
| U2  | P2  | product       | Audit writes are fail-open                                                                          |
| U3  | P2  | product       | Discord plan roles follow Stripe, not the effective plan                                            |
| R3  | P3  | reliability   | Several cron lanes swallow errors and look successful                                               |
| R4  | P3  | reliability   | Stripe records the event id after the handler                                                       |
| R5  | P3  | reliability   | Invocation-token mint and values read are still reachable                                           |
| S7  | P3  | security      | 2026-09-16 lows and mediums still open (IPs, mail reply, logout GET, authorize HTML, content types) |
| C6  | P3  | cost          | UserMeter deletes stale counters on every consume                                                   |
| O2  | P3  | observability | Search latency is operator SQL, not an insights chart                                               |
| O3  | P3  | observability | Onboarding funnel is cumulative stamps, not step drop-off                                           |
| U4  | P3  | product       | `/pricing` Teams strip vs single-user intent                                                        |
| U5  | P3  | product       | 2026-09-16 accessibility items still match the source                                               |
| U6  | P3  | product       | Experiments audience has no insights count                                                          |
| D1  | P2  | DX            | Worker source size is unratcheted; several modules are thousands of lines                           |
| D2  | P3  | DX            | Documented import cycles are not linted                                                             |
| X1  | P2  | ops           | Disaster-recovery drill evidence is from 2026-08-07, with named unproven lanes                      |
| X2  | P3  | docs          | Code-health receipt and a few catalog phrases are stale                                             |

## Architecture and boundaries

Production is four product scripts plus independent ops workers. Origin owns
zero Durable Object classes in steady state
([ADR 0034](../contributing/decisions/0034-origin-owns-no-durable-objects.md)).

| Script                       | Entry                                      | Owns                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kody-production`            | `packages/worker/src/production-worker.ts` | Remix, MCP HTTP, OAuth, inbound email, queue consumers. Exports `JobsHost` and a loopback `KodyFetchGateway` for the origin-only execute smoke. Does not export Durable Object classes.                                                                                                   |
| `kody-platform`              | `packages/worker/src/platform-worker.ts`   | `MCP`, `McpClientHub`, `OAuthPurgeCoordinator`, `UserMeter`, `Mailbox`, `RepoSession`, `RepoSessionIndex`, `StripePlanRefresh`. Loopback `KodyFetchGateway` and `PackageAppRuntimeBridge` because MCP `execute` runs inside the platform `MCP` object. HTTP is `/__platform/health` only. |
| `kody-runtime`               | `packages/worker/src/runtime-worker.ts`    | `StorageRunner`, `RunLog`, `PackageRealtimeSession`, `DynamicCallableWorkflow`, plus its own gateway and package-app bridge. Public `{user}.kody.run`.                                                                                                                                    |
| `kody-jobs`                  | `packages/jobs-worker`                     | `JobManager`, `JOBS_DB`, cron, callback to origin `JobsHost`.                                                                                                                                                                                                                             |
| `kody-highlight`             | `packages/highlight-worker`                | Shiki. Service binding only.                                                                                                                                                                                                                                                              |
| `kody-status`                | `packages/status`                          | Public status page.                                                                                                                                                                                                                                                                       |
| `kody-nx-cache`              | `packages/nx-cache`                        | CI cache.                                                                                                                                                                                                                                                                                 |
| `kody-production-d1-backups` | `packages/backup-control-plane`            | D1 backup workflows.                                                                                                                                                                                                                                                                      |

Historical Durable Object class names (`ChatAgent`, `SchedulerDO`,
`AgentTurnRunner`, `PackageServiceInstance`, and the `HomeConnectorSession`
rename) remain in `packages/worker/wrangler.jsonc` so old migrations can replay.
That is expected, not a live binding.

Import layers are enforced downward (`#app` → `#mcp` → `#worker` →
`#universal`). Known leftover cycles, documented in
[`import-boundaries.md`](../contributing/import-boundaries.md) and not yet
linted: jobs modules cycle with `#mcp/jobs-vectorize.ts` and
`#mcp/jobs-embed.ts`; community, email, webhooks, scheduled lanes, and
unverified-account purge still import `#app/*`. See D2.

Capability domains under `packages/worker/src/mcp/capabilities/` are account,
admin, apps, coding, community, email, integrations, invocation-tokens, jobs,
mcp-servers, meta, packages, repo, runs, secrets, storage, values, and webhooks.
Public MCP tools stay `search` and `execute`. That matches project intent. Do
not grow a third tool.

Per-user names are centralized in
`packages/worker/src/user-scoped-durable-object-name.ts`. `RepoSession` is the
documented exception (name is the session id; the row's `user_id` is checked
before use). Person accounts cannot be delegated; `resolvePackageOwnerContext`
only resolves a foreign package scope for `account_type = 'platform'` plus an
explicit grant.

Two retirement soaks are still on the execute path by runbook, not by accident.
See R5.

## Reliability and correctness

### R1 — P2 — Scheduled-job claims retry forever or abort the batch

**Evidence.** `computeJobRetryAt` in
`packages/worker/src/jobs/execution-safety.ts` caps delay at five minutes and
has no retry ceiling. In `runDueJobsForUser`
(`packages/worker/src/jobs/service.ts`) only `TransientJobExecutionError` calls
`retryClaimedJob`. Any other throw leaves the function, so later due jobs in
that alarm do not run. `claimJobRow` holds a 10-minute lease; only the retry
path clears `claim_token` and increments `retry_count`. `JobManager.alarm`
rethrows host failures so the platform retries the alarm. User-code failures
that return an outcome are finalized and are outside this loop. Occurrence
idempotency (`scheduled-job:${jobId}:${scheduledFor}`) prevents double execution
of the same slot.

**Blast radius.** One permanently failing job for a user keeps firing (about
every 10 minutes once the lease drops) and delays the rest of that user's due
batch on the failing tick. Not cross-user.

**Next step.** Cap retries, then disable or quarantine the job, and release the
claim on non-transient errors so the alarm can finish the batch.

**Needs Kent?** Yes, for what "give up" means on a user's schedule. The
release-the-claim part does not.

**False-positive risk.** Low for the control flow. Medium if every non-transient
throw is already rare in production.

### R2 — P2 — Job delete drops the row before the vector

**Evidence.** `deleteJob` in `packages/worker/src/jobs/service.ts` awaits
`jobsData().deleteJob` and only then `deleteJobVector`. The package-job sync
loop does the same. Account deletion rebuilds vector ids from rows that still
exist (`listJobIdsForUser`). A vector left behind is invisible to that purge.
`tryDeleteVectorEmbedFingerprint` is fail-open by comment, so a fingerprint miss
does not block the vector delete, but a throw after the row is gone is not
retried into a cleanup.

**Blast radius.** Search can still return a deleted job. A later account purge
will not see that id. The caller sees the delete error; a retry hits "not found"
and never cleans the index. Same user.

**Next step.** Delete the vector, or record a cleanup debt row, before removing
the job row.

**Needs Kent?** No.

**False-positive risk.** Low for the order. The fingerprint fail-open is
intentional for upserts; the bug is the combination with row-first delete.

### R3 — P3 — Several cron lanes swallow errors and look successful

**Evidence.** `packages/shared/src/jobs/scheduled-lanes.ts` maps `failed` to
ack. Only `d1_lock_contention` retries, because a retry could repeat billing,
email, or Kit calls. Inside `packages/worker/src/scheduled/scheduled-lanes.ts`,
Kit sync, fleet error-rate refresh, admin insights snapshot, and entitlement
email steps catch and return a failed or skipped result. The queue consumer then
sees success. Invalid lane messages are acked
(`packages/jobs-worker/src/scheduled.ts`). `retry_exhausted` still calls
`retry()`, which is the path into `kody-scheduled-dispatch-dlq` after
`max_retries: 3`.

**Blast radius.** One lane, until the next cadence. Other lanes still run
(`max_batch_size: 1`).

**Next step.** Keep the no-retry rule for side effects. Report the inner failure
as a lane failure or a dedicated alert instead of a successful return.

**Needs Kent?** No.

**False-positive risk.** Medium. The terminal ack is documented. The gap is the
inner `console.warn`.

### R4 — P3 — Stripe records the event id after the handler

**Evidence.** The header of `packages/worker/src/billing/stripe-webhooks.ts`
says the handler runs, then `recordStripeWebhookEvent` inserts. Unique conflicts
return `duplicate`. Failures do not insert, so Stripe retries. Referral credit
updates require `credits_granted_at IS NULL`. Payment-failed email uses a
day-keyed claim. Overage invoices send Stripe idempotency keys
(`kody-overage-invoice:${userId}:${month}` in
`packages/worker/src/billing/compute-overage-invoices.ts`).

**Blast radius.** Overlapping deliveries can both enter plan refresh and
referral logic. The money paths checked are conditional.

**Next step.** Insert the event id as a claim first, then process. Keep
500-without-insert on handler failure.

**Needs Kent?** No.

**False-positive risk.** High for "double charge."

### R5 — P3 — Invocation-token mint and values read are still reachable

**Evidence.** ADR 0048 and the invocation-token retirement runbook keep token
tables until leftover rows are zero. `handleAccountPackageTokenAction` in
`packages/worker/src/app/handlers/account-packages.ts` can still insert a token.
The MCP domain is `unadvertised` and list/get only. ADR 0022 and the values
retirement runbook keep `valueGet` / `valueList` / `valueDelete` until the
tables drop. `value_buckets` and `value_entries` are still created in
`packages/worker/migrations/0001-squashed-init.sql`. No later migration drops
them.

**Blast radius.** New tokens can still be minted, so the drain never reaches
zero if the account UI is used. A package can still call `kody.valueGet`.
Neither path is advertised in search. Dropping the tables while the handlers
remain would be the actual outage. That has not happened.

**Next step.** Follow the runbooks. Do not drop tables in the same deploy that
removes the handlers.

**Needs Kent?** Yes, only if minting should stop before the row count is zero.

**False-positive risk.** High if treated as accidental dead code. This is an
accepted soak.

**Checked and not a defect.** Account deletion throws before the user row
disappears when inventory or vector cleanup fails
(`packages/worker/src/app/account-deletion.ts`). Unverified purge claims are
fenced on `email_verified_at IS NULL`. Feature-flag evaluation for authenticated
HTML fails closed if D1 throws
(`packages/worker/src/app/request-feature-flags-cache.ts`). Webhook and email
delivery queues ack or retry per message and have dead-letter queues. A
15-minute job-schedule watchdog pages overdue jobs and re-arms alarms with a
50-user cap (`packages/jobs-worker/src/watchdog.ts`).

## Security, tenancy, secrets, OAuth, MCP

No remote unauthenticated takeover and no cross-user read showed up. The
findings are same-user confused deputies.

### S1 — P1 — Admin role on background package callers

**Evidence.** `loadBackgroundMcpUser` in
`packages/worker/src/identity/background-mcp-user.ts` loads `roles` and
`permissions`. The comment says omitting roles hides `admin_*` tools even for
admin owners. `packages/worker/src/jobs/service.ts`,
`packages/worker/src/package-runtime/package-workflows.ts`,
`packages/worker/src/package-runtime/realtime-session.ts`, and
`packages/worker/src/package-retrievers/service.ts` pass that user through with
a background origin. `adminCapabilityAccess` in
`packages/worker/src/mcp/capabilities/admin/admin-shared.ts` is only
`requiredRole: 'admin'`. `callerCanAccessCapability` in
`packages/worker/src/mcp/capabilities/access-control.ts` checks role,
permission, and feature flag. It does not check `executionOrigin`. Hosted
package apps do not do this: `PackageAppRuntimeBridge.createCallerContext` in
`packages/worker/src/package-runtime/package-app.ts` sets `user` to id, email,
and display name only, so `roles` is absent and admin capabilities stay out of
that map.

**Blast radius.** A job, webhook, workflow, retriever, or `packages.invoke` on
an admin-owned package, including a community fork that admin installed, can
call admin MCP as that admin. Not cross-user for non-admin accounts. Not the
hosted package-app HTTP bridge.

**Next step.** Keep admin capabilities off background package callers unless the
package is an explicit operator tool, not merely owned by an admin.

**Needs Kent?** Yes. The comment records intent for the operator's own packages.
The inconsistency with package apps is the bug-shaped part.

**False-positive risk.** Medium if every admin-owned package is meant to be a
trusted operator.

### S2 — P1 — Default `usage_mode` `any` for integrations and remote MCP

**Evidence.**
`packages/worker/migrations/0026-integration-owned-credentials.sql` and
`0031-mcp-server-package-usage.sql` add
`usage_mode TEXT NOT NULL DEFAULT 'any'`. `assertCanUseIntegration` in
`packages/worker/src/integrations/package-access.ts` returns immediately when
mode is `any`. The MCP server equivalent does the same. `packages` mode does not
auto-pass self-authored packages; it requires an allow-list. New settings rows
are written as `usage_mode: 'any'`
(`packages/worker/src/mcp-client/settings-service.ts`). This is separate from
user-secret adoption: an unadopted fork can be denied secrets and still call
`createAuthenticatedFetch` or `kody.mcp[...]`.

**Blast radius.** Same user's connected third-party accounts and remote MCP
servers. Not other users' rows. Not listed as an accepted residual in
`security.md`, though the architecture docs describe the mode.

**Next step.** Decide whether new connections default to `packages`, or whether
community forks are denied even when the mode is `any`.

**Needs Kent?** Yes. This is the product model of "a running package is the
user," applied to OAuth and remote MCP but not to user secrets.

**False-positive risk.** Medium if that model is intentional. Low that the
default is `any`.

### S3 — P1 — Secret-authority runner reachable via well-known symbols

**Evidence.** Still open from 2026-09-16 H2. `createRuntimeModuleSource` in
`packages/worker/src/package-runtime/runtime-source-modules.ts` hangs
`Symbol.for('kody.runWithSecretAuthority')` on
`Symbol.for('kody.getSecretAuthority')`. `resolveSecretAuthorityPackageId`
accepts any requested id that is already in the run grant set.
`package-secret-authority.workers.test.ts` does not call the run symbol (no
match for that name).

**Blast radius.** Same user. Package B that already imports A can restamp as A
for `packageSecrets` and `{{secret}}` inside the grant set. If A is
self-authored, implicit read covers the owner's user secrets. Not cross-user.

**Next step.** Keep the runner in a closure the bundler wrapper owns. Add a
workers test that the symbol cannot restamp.

**Needs Kent?** No.

**False-positive risk.** Low that the symbol is reachable. Medium that a useful
grant id is in the set. Not exercised as a live workers proof in this review.

### S4 — P2 — Consent-sensitive capabilities stay on the sandbox map

**Evidence.** 2026-09-16 H1 is partially fixed. `assertDirectMcpCaller` in
`packages/worker/src/mcp/capabilities/community/adopt.ts` refuses a
non-interactive origin and any package, app, or storage id. Background and
package-app self-adopt is blocked. `buildKodyFns` in
`packages/worker/src/mcp/run-kody-registry.ts` copies the filtered capability
map with no name denylist. Interactive `execute` stamps
`executionOrigin: 'interactive'` and no storage context, so imported package
code inside that execute can still call `kody.communityForkAdopt`.
`communityPublish` and `packageDelete` have no origin check. `packageDelete`
requires `confirm_name` to equal the package name, which the package knows.
`packageShareInvite` is feature-flagged, not origin-gated.

**Blast radius.** The owner's packages (publish, delete, share, adopt) when
untrusted code runs through `execute` or a background caller that is not caught
by the existing gates. Not other users.

**Next step.** Mark consent-sensitive capabilities interactive-only and omit
them from sandbox `kody.*`. Do not invent a blanket "packages cannot call
`kody.*`."

**Needs Kent?** Yes, for which mutations are consent-sensitive. Email, storage,
and similar are meant to run from packages.

**False-positive risk.** Medium. "Packages act as the user" is a real product
model. The inconsistency with the gates that already exist is the finding.

### S5 — P2 — Hub MCP tokens are not the secret-store cipher

**Evidence.** Integration access and refresh tokens use `v2.` AES-GCM with
identity AAD (`encryptSecretValue`). Remote MCP OAuth tokens and optional
`bearerToken` values live in the per-user hub Durable Object, not D1.
`docs/contributing/architecture/mcp-client-servers.md` says so, and account
export excludes `McpClientHub` because it holds those tokens. The hub id is
`mcpClientHubDurableObjectName(userId)`.

**Blast radius.** That user's remote MCP credentials if hub storage is read
(backup, support, same-isolate bug). Not a cross-user D1 row swap. Cloudflare
encrypts Durable Object disks at rest.

**Next step.** Encrypt hub token blobs with the same purpose-and-user AAD, or
record plaintext-at-the-application-layer as an accepted residual next to the
secret-store section of `security.md`.

**Needs Kent?** No, unless the residual is the chosen answer.

**False-positive risk.** Medium. The object is per user.

### S6 — P2 — `integrationSave` create skips the host-approval check

**Evidence.** `assertIntegrationSaveKeepsApprovedHosts` in
`packages/worker/src/mcp/capabilities/integrations/integration-save.ts` runs
only when `existing` is set. `createNewIntegrationConfig` accepts `tokenUrl`,
`apiBaseUrl`, and `requiredHosts` as given. Updates cannot add hosts. No
`executionOrigin` check. Tokens do not exist until the owner finishes
`/connect/oauth`.

**Blast radius.** Same user, and only after that connect screen. A package
cannot silently retarget an already-connected integration.

**Next step.** Apply the approved-host check on create, or refuse creates from
package runtimes.

**Needs Kent?** No.

**False-positive risk.** Medium. The connect screen is still the consent step.

### S7 — P3 — 2026-09-16 items still open

Re-read, not re-litigated. None of these is a current exploit under
`SameSite=Lax` and static error strings.

| Prior             | Status | Path                                                                                                                                                  | Next step                                                           | Needs Kent?                 |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| M2 IP hosts       | Open   | `classifyNormalizedApprovalHost` in `packages/worker/src/mcp/secrets/approval-host-shape.ts` returns `reason: null` for canonical IPv4 and IPv6       | Reject IP hosts, or at least loopback, link-local, and RFC1918      | Yes (the UI shows the host) |
| M3 mail           | Open   | `resolveInboundEmailAuthVerdict` fail-open is the documented residual. `deriveReplyRecipient` still prefers Reply-To, then header From, then envelope | Reply from envelope From unless DMARC/SPF passed                    | Yes                         |
| L1 avatar         | Open   | `createAccountAvatarApiPostHandler` parses non-JSON as `FormData`                                                                                     | Require `multipart/form-data` or `application/json`                 | No                          |
| L2 logout         | Open   | `handleOidcLogoutRequest` accepts GET and HEAD                                                                                                        | Require POST or a valid `id_token_hint` before clearing the session | No                          |
| L3 authorize HTML | Open   | `standaloneAuthorizeErrorHtmlResponse` interpolates `message` with cache and content-type headers only                                                | HTML-escape and apply first-party security headers                  | No                          |
| L4 resend         | Open   | Resend-verification sends mail when `Content-Type` is not JSON                                                                                        | Require JSON or return 415                                          | No                          |

**Healthy security (do not "fix").** Package HTTP strips `cookie`,
`authorization`, and `x-kody-*` before package code sees the request. User
secrets are AAD-bound `v2.` ciphertext. Memory search sets
`namespace: userVectorNamespace(userId)` and filters metadata `userId`.
Secret-bearing fetch checks the host after placeholder expansion and forces
`redirect: manual` when secrets were referenced. Discord guild join sends one
ephemeral `guilds.join` token and does not store it. Admin HTTP uses
`requirePageUserWithRole(..., 'admin')`. Open Dynamic Client Registration, no
CSRF tokens while JSON plus `SameSite=Lax` hold, PBKDF2-SHA256 100k, and no
general sandbox SSRF denylist stay accepted residuals.

## Performance and cost

No latency samples and no bill totals were measured for this review. Caps below
are the ones written in code or in the cited docs.

### C1 — P1 — Unbounded package SQL

**Evidence.** `cursorToSqlResult` in `packages/worker/src/storage-runner.ts`
does `cursor.toArray()` with no `LIMIT` rewrite and no `rowsRead` abort.
`assertStorageSqlAllowed` only splits read-only from writable. The customer
meter is applied afterward via `recordDurableObjectRowsRead`
(`packages/worker/src/usage/durable-object-rows.ts`) and skips `rowsRead < 1`.
KV list and export are already paged. Other customer Durable Objects are not on
this meter. Includes in
[`entitlements.md`](../contributing/architecture/entitlements.md): Free 0.5B,
Standard 5B, Pro 20B rows. Overage in `computeOverageRatesUsd` is `$0.0015` per
million when `compute-overage-charging` is on
(`packages/worker/universal/plans.ts`).

**Blast radius.** One `storageQuery` on a large bucket. Owner bill, operator
Durable Object rows-read, and RPC memory. No cap in code.

**Next step.** Cap or set `truncated` at the existing export page size, and say
so on the storage capability.

**Needs Kent?** Only if package SQL is promised unbounded.

**False-positive risk.** Low that it is unbounded. Authors can write `LIMIT`.
The platform still pays if they do not.

### C2 — P2 — Eager `isomorphic-git` and `marked`

**Evidence.** `packages/worker/src/repo/repo-session-do.ts` still has
`import rawGit from 'isomorphic-git'` and `isomorphic-git/http/web`.
`loadIsomorphicGit()` exists and is used by artifact and publish paths, not by
`RepoSession`. `platform-worker.ts` statically re-exports `RepoSession`. Origin
slim entry forbids `repo-session-do.ts`. The static origin chain is
`production-worker.ts` → `origin-handler.ts` → `app/router.ts` → blog and other
handlers → `packages/worker/src/app/highlight-code.ts`, which imports `lexer`
from `marked`. Shiki itself is the highlight worker, not this import.

[`startup-budget.md`](../contributing/architecture/startup-budget.md) says heavy
libraries load on first use. Its reference table (not a fresh profile) is origin
budget 280 ms (CI reading 186 ms), platform 340 ms (CI 228 ms), runtime 160 ms
(CI 102 ms). This review did not run `wrangler check startup`.

**Blast radius.** Every platform isolate start, including health, for git. Every
origin isolate start, including routes that never render markdown, for `marked`.

**Next step.** Route `RepoSession` through `loadIsomorphicGit()`. Dynamic-import
`highlight-code` from the handlers that need it. Re-profile before lowering
`tools/worker-startup-budget.json`.

**Needs Kent?** No.

**False-positive risk.** Low that the imports are eager. Medium that either is
over the upload ceiling today. The committed budgets still pass if CI is near
the documented readings.

### C3 — P2 — Authenticated search awaits D1 writes

**Evidence.** `consumeSearchRateLimit`
(`packages/worker/src/search-rate-limit.ts`) awaits the plan and two
`checkRateLimit` batches. Each batch is a D1 `DELETE` plus conditional `INSERT`
on `_rate_limits`. A successful search then awaits `stampFirstSearch`. The
comment says `waitUntil` is wrong because the leftover-steps notice reads
`first_search_at` in the same request. Successful `execute` stamps
`first_execute_at` off the critical path when `waitUntil` is passed.
[`invocation-overhead-guardrails.md`](../contributing/architecture/invocation-overhead-guardrails.md)
requires a PR justification for new awaited D1 writes on execute and related
paths. Search is not on that list.

Search ceilings in code, not entitlements: free 80/min and 1,000/day through max
240/min and 25,000/day. A source comment claims about `$0.0009` per search with
Jev. That comment is not a measured bill. Do not treat it as one.

**Blast radius.** Every authenticated MCP search. No latency sample here.

**Next step.** Keep the first-search stamp await only until `first_search_at` is
set. Cache the plan and rate-limit result per isolate with a stated TTL. Do not
move the first successful stamp to `waitUntil` without fixing the onboarding
notice.

**Needs Kent?** Yes if search rate limits should leave D1.

**False-positive risk.** Low that the writes exist. Medium that they dominate
versus embeddings and Vectorize.

### C4 — P2 — Jev and embeddings are operator-paid

**Evidence.** Workers AI binding `AI` is on origin, platform, and runtime.
Embeddings use `@cf/baai/bge-small-en-v1.5` at 384 dimensions
(`packages/worker/src/vectorize/embedding.ts`). Query-path cache is an
in-request `Map`. `jev-search-rerank` runs only when the flag is on, the plan is
standard, pro, or max, and necessity says the pool is ambiguous
(`packages/worker/src/mcp/tools/search-jev-rerank.ts`). Caps in code: 40 cards,
wide recall 50, Vectorize `topK` capped at 100. No direct-AI fallback. No AI
token entitlement. Customer overage that exists is unique worker-days and
Durable Object rows-read only. Operator helper for Dynamic Workers, not AI:
`$0.002` per unique worker-day, 1,000 included per account per month
(`packages/worker/universal/dynamic-worker-cost.ts`). Customer list for that
meter is `$0.0025` (`computeOverageRatesUsd`).

**Blast radius.** Paid ranked search and every embedding miss, on the operator's
AI bill. Search daily ceilings are the backstop in code. No dollar cap in code.

**Next step.** Confirm the production AI Gateway is Unified Billing versus BYOK
in the operator account. Do not add a user AI meter unless search should join
the public ladder.

**Needs Kent?** Yes, for who pays the gateway.

**False-positive risk.** Low for "not customer-metered."

### C5 — P2 — Mailbox list selects full bodies and uses OFFSET

**Evidence.** `listMessages` and `searchMessages` in
`packages/worker/src/email/mailbox-store.ts` are `SELECT *` with `LIMIT` and
`OFFSET`. Account UI drops bodies after the Durable Object returns them.
`countMessages` is a separate `COUNT(*)`. Stored bodies are truncated to 65,536
bytes (`maxRestorableTextColumnBytes` in
`packages/shared/src/backup-restore-safety.ts`). Mailbox is not on the customer
rows-read meter.

**Blast radius.** Account email pages. Operator Durable Object rows and RPC
size.

**Next step.** Metadata columns on list and search. Bodies only on `getMessage`.
Use the existing cursor in the account page.

**Needs Kent?** No.

**False-positive risk.** Low for the column set. Medium that deep OFFSET matters
at current mailbox sizes.

### C6 — P3 — UserMeter deletes stale counters on every consume

**Evidence.** `deleteStaleCounters` in
`packages/worker/src/entitlements/user-meter-do.ts` runs on consume. Indexes
exist. No once-per-day throttle. Not in `durable_object_rows_read`.

**Blast radius.** Execute, email, and fetch entitlement consumes. Extra SQLite
work, usually matching zero rows.

**Next step.** Throttle in Durable Object meta to once per UTC day.

**Needs Kent?** No.

**False-positive risk.** Medium. Empty deletes may be cheap.

**Inventory, not findings.** Most origin consumers use `max_batch_size` 10 and
`max_retries` 3 with a dead-letter queue. Webhook dispatch is `max_batch_size` 1
and `max_retries` 10 (`packages/worker/wrangler.jsonc`). No code reads
dead-letter depth. `kody-jobs` cron is `*/5 * * * *`. Status cron is every
minute. Byte ratchets in `tools/check-worker-startup-bundles.ts`: origin
7,750,000, platform 5,128,000, runtime 3,805,000. Line ratchets cover client
routes (800) and `*.node.test.ts` (2,000), not `packages/worker/src`. ADR 0047:
one Vectorize namespace per user, do not shard before 5,000 person accounts. The
50,001st namespace fails as silent reindex debt. Cited account count in that
decision is 172 on 2026-09-01. Current count is not in this review. See O1.

## Observability and incident readiness

### O1 — P2 — Status and probes miss the quiet failures

**Evidence.** `packages/status` probes, every minute: `GET /health`,
`GET /health/components`, unauthenticated `/mcp`, runtime health, and jobs
health. Cards are app, MCP, package runtime, jobs, `app_db`, kv, and assets.
`audit_db` is operator-only and does not email. Incidents open after two
failures. Email goes to `ALERT_EMAIL_TO` with a daily cap.

`collectHealthComponents` in
`packages/worker/src/app/handlers/health-components.ts` checks `app_db`,
`audit_db`, `kv`, and `assets`, plus a KV timestamp for execute evidence. It
does not check Vectorize, Workers AI, queues, or the highlight binding.
`kody-platform` `/__platform/health` is not a public card. Execute success calls
`scheduleFleetExecuteLastSuccess` (timestamp only). A green execute card means a
success in the last hour, not proof of Vectorize or Jev. When no organic success
landed in the previous minute, the status worker runs at most one synthetic
execute per hour.

Sentry wraps origin, platform, and instrumented Durable Objects.
`SENTRY_TRACES_SAMPLE_RATE` is `0` so the SDK does not double-sample. Workers
traces are on. Head sampling rate is not set in
`packages/worker/wrangler.jsonc`. The request-lifecycle doc says the default is
full and shares the Workers Logs included quota. No Honeycomb. No Highlight.io
product (the highlight worker is syntax highlighting).

Hourly package alerts exist for auth-denial burst (threshold 50 in 60 minutes),
email delivery, verification stall, entitlement crossings, and fleet package
error rate. Those notify admin packages, not a pager.

**Blast radius.** Search index, Jev, queue backlog, and the platform Durable
Object worker can be down while `status.kody.codes` stays green. Highlight
failure already falls back to plaintext, so a missing highlight probe is not a
public outage.

**Next step.** Operator alerts for dead-letter depth and for Vectorize or AI
errors. Do not put those on the public page unless they take the product down.
Read `adminUserList.total` before the next search change; alert if a
namespace-limit error appears. Do not shard before 5,000 accounts unless that
error shows up (ADR 0047).

**Needs Kent?** Which of those should page.

**False-positive risk.** Low that the probes are absent. High that the namespace
ceiling is urgent today.

### O2 — P3 — Search latency is operator SQL

**Evidence.** `kody_mcp_search_events` gets one privacy-safe point per search,
including Jev (`packages/worker/src/mcp/tools/search-observability.ts`).
`docs/contributing/architecture/request-lifecycle.md` says `/admin/insights` has
no search-latency chart. `recordUsage` writes Analytics Engine when
`USAGE_EVENTS` is bound.

**Blast radius.** Incident diagnosis for search, not user-facing history.
`/account/activity` and run records cover user history.

**Next step.** A saved query or insights tile for search duration and
`jevOutcome`.

**Needs Kent?** No.

**False-positive risk.** Low.

### O3 — P3 — Onboarding funnel observability (gaps only)

What is measurable today is cumulative stamps on `users`, counted on
`/admin/insights` (`packages/worker/src/admin/launch-signals.ts`): `signed_up`,
`email_verified`, `first_mcp`, `first_search`, `first_execute`,
`first_saved_package`. Wizard steps in
`packages/worker/universal/onboarding-process.ts` are derived. Step 3 is two
distinct OAuth client ids, not a timestamp. There are no page-visit or drop-off
events. `first-win` is not a checklist item and is not probed.

This review does not design events. Another change owns funnel implementation.

**Needs Kent?** Only if the admin funnel is not enough.

**False-positive risk.** Low that step-open drop-off is missing.

## Product and UX

### U1 — P2 — Community unban is unreachable

**Evidence.** `/admin/community-reports` can dismiss, delist, delete, or ban
(`packages/worker/src/app/handlers/admin-community-reports.ts`).
`banCommunityUser` writes `community_bans`. `unbanCommunityUser` in
`packages/worker/src/community/service.ts` has no callers outside its
definition. Neither path calls `logAuditEvent`. The report row and
`banned_by_user_id` are the trail.

**Blast radius.** A banned account stays banned unless someone writes D1.

**Next step.** Wire an audited unban, or delete the dead function and document
the SQL procedure in the operator runbook.

**Needs Kent?** Whether unban is a product action.

**False-positive risk.** Low. Single definition, no other callers.

### U2 — P2 — Audit writes are fail-open

**Evidence.** `logAuditEvent` in `packages/worker/src/audit-log.ts` catches sink
failures and returns `{ persisted: false }`. Admin HTTP mutations use
`void logAuditEvent`, so a dropped `AUDIT_DB` write does not fail the mutation.
MCP admin mutations mostly await `auditAdminCapabilityInvocation` and still do
not roll back. Experiments opt-in uses the same `void logAuditEvent` pattern
(`packages/worker/src/app/handlers/account-experiments.ts`).

**Blast radius.** Operator history for destructive admin writes, and for
experiment opt-in if the audit database is down.

**Next step.** Await and fail the mutation when `persisted` is false for
destructive admin writes (ban, delete, role, flag kill switch). Leave
informational events fail-open.

**Needs Kent?** No.

**False-positive risk.** Low.

### U3 — P2 — Discord plan roles follow Stripe, not the effective plan

**Evidence.** `desiredDiscordPlanRole` in
`packages/worker/src/discord/guild-role.ts` returns a role only for
`stripePlan === 'standard' | 'pro'`. Manual `max`, the second-agent Standard
gift, and referral overlays never reach Discord. ADR 0029 already stated this;
the code still matches. Join failures never fail login (ADR 0030).

**Blast radius.** Guild role cards and paid-role badges. Login still succeeds.

**Next step.** Decide Stripe-only versus `resolveEffectivePlan`.

**Needs Kent?** Yes.

**False-positive risk.** Low.

### U4 — P3 — Pricing is coherent with `planLimits`, except Teams

**Evidence.** `/pricing` (`packages/worker/client/routes/pricing.tsx`) renders
free, standard (`$12` / `$10` billed annually), and pro (`$49` / `$40` billed
annually) from the page, and the limit table from `planLimits`. `max` is not a
column. `parseStripePlanName` cannot produce `max`. Overage copy uses
`computeOverageRatesUsd` (`$0.0025` per unique worker day, `$0.0015` per million
rows). The Teams / Enterprise strip is a mailto to `kody@kody.codes` and says
the offering is still being shaped.
[`project-intent.md`](../contributing/project-intent.md) says the product does
not need to optimize for per-organization tenancy. Stripe charge amounts are not
in source, only price-id environment variables plus this copy.

**Blast radius.** Checkout expectations, not a double-charge path found in code.

**Next step.** None on the numbers. Keep Teams as a contact strip, or drop the
word Enterprise until there is a product.

**Needs Kent?** Yes, for Teams copy only.

**False-positive risk.** High if "Stripe products might differ" is treated as a
code bug. Amounts are not in the repo.

### U5 — P3 — 2026-09-16 accessibility items still match the source

No browser pass in this review. Source still matches that audit:

- `packages/worker/client/site-header.tsx` uses a `popover` without a Tab trap
  or `aria-controls`.
- Play, profile search, fork-outdated copy, and secret host fields still lack
  the names called out in that audit.
- `packages/worker/client/app.tsx` focuses `[data-docs-heading]` or `#main`. The
  heading attribute is on docs routes only.
- Password errors are `role="status"`. OAuth query errors are
  `aria-live="polite"` without `role="alert"`.
- `package-webhook-settings.tsx` still replaces the card list with "Loading
  webhooks…".
- `defaultToastDurationMs` in `packages/worker/client/toast.ts` is 4000 for info
  and success. Errors persist.

**Next step.** Dialog or focus trap on the menu, then heading focus and toast
duration. Do not clear the previous page while waiting (no-flash is real; see
non-findings).

**Needs Kent?** No.

**False-positive risk.** Medium on the menu if it is a disclosure rather than a
modal. The dimmed backdrop argues modal.

### U6 — P3 — Experiments exist; opt-in count is not on insights

**Evidence.** `/account/experiments` writes `users.experiments_opt_in`
(migration `0065-experiments-opt-in.sql`). Feature-flag audiences are `everyone`
and `experiments_opt_in`
(`packages/worker/universal/feature-flags/audiences.ts`). Opt-in and opt-out
write an audit event (fail-open, see U2). The typed registry has six keys:
`demo-indicator`, `compute-overage-charging` (default on),
`compact-mcp-server-instructions`, `package-share-grants`, `secret-providers`,
and `jev-search-rerank`. Each has a gate. No orphan key in the registry.
`/admin/insights` launch signals do not count opt-ins.

**Blast radius.** An operator cannot see the audience size without an audit
query or SQL.

**Next step.** A count on insights, or leave it as an audit-log query. Do not
add a flag until there is a gate site.

**Needs Kent?** When to end the compact-instructions experiment. The flag is off
unless an operator turns it on. Hosts that never call `search` still see the fat
instruction path.

**False-positive risk.** Low that the count is missing. High that the
experiments page itself is broken. This review did not click it.

Agent DX is the intended contract. Search and execute return `isError` plus
structured content. Role, permission, and `featureFlag` hide capabilities from
search and deny execute. Progressive disclosure is ADR 0023.
`retiringPrimitiveNotices` is empty. Domain blurbs in instructions are clipped.
That is the design, not a missing third tool.

## DX, maintainability, tests, CI

### D1 — P2 — Worker source size is unratcheted

**Evidence.** `tools/check-file-size-ratchet.ts` budgets client routes (800) and
`*.node.test.ts` (2000). `tools/file-size-ratchet.json` is empty for those
groups, so the check is live and nothing is grandfathered there.
`packages/worker/src` has no line budget. Largest non-test modules, line counts
from `wc -l` during this review:

| Lines | Path                                                 |
| ----: | ---------------------------------------------------- |
|  4019 | `packages/worker/src/run-records/run-log-do.ts`      |
|  3192 | `packages/worker/src/repo/repo-session-do.ts`        |
|  2144 | `packages/worker/src/community/service.ts`           |
|  2097 | `packages/worker/src/package-runtime/package-app.ts` |
|  2080 | `packages/worker/src/account/export.ts`              |
|  1915 | `packages/worker/src/entitlements/user-meter-do.ts`  |
|  1818 | `packages/worker/src/app/account-deletion.ts`        |
|  1813 | `packages/worker/src/jobs/service.ts`                |
|  1810 | `packages/worker/src/mcp/executor.ts`                |

`router.ts` is about 619 lines. `handler.ts` is small. The hotspots are the
Durable Objects and the community/jobs/execute services, not the HTTP router.
Client routes sit just under the ratchet
(`packages/worker/client/routes/admin-users.tsx` at 799). Node tests sit just
under 2000 (`packages/worker/src/app/ssr-render.node.test.ts` at 1999).

**Blast radius.** Every change in run logs, repo sessions, community, jobs, and
execute. Size is not proof of spaghetti. It is proof that review and isolate
startup for those modules are expensive to reason about. The isomorphic-git
import in C2 lives in the 3,192-line session object.

**Next step.** Extend the ratchet to `packages/worker/src` with a shrink-only
snapshot, or split `run-log-do.ts` and `repo-session-do.ts` first. Do not boil
the ocean in one PR.

**Needs Kent?** No.

**False-positive risk.** Low for the counts. Medium that line count alone means
the module is unstructured.

### D2 — P3 — Documented import cycles are not linted

**Evidence.** [`import-boundaries.md`](../contributing/import-boundaries.md).
Oxlint covers the downward direction. The jobs ↔ MCP embed cycle and the
`#worker/*` → `#app/*` edges are listed as known and excluded.

**Next step.** Extract the job vector id the way `#worker/vectorize/*` was, then
extend the rule. One cycle per change.

**Needs Kent?** No.

**False-positive risk.** Low.

**CI, as written.** `.github/workflows/validate.yml` runs on non-draft pull
requests and `main`: format, lint, typecheck, worker builds, startup bundle and
time, origin exports, slop ratchet, knip, primitives, migrations, deploy
guardrails, temporal docs, decisions, mermaid, node tests, workers tests, MCP
end-to-end, and Playwright. Draft pull requests skip the workflow. Forks run
validate; preview skips forks and drafts. Deploy runs only after Validate on a
`main` push. Path filters can skip platform, runtime, jobs, highlight, backup,
status, and nx-cache. CLA, MCP registry publish, weekly site perf, DR escrow,
and secret re-encryption are separate workflows. Whether CLA is a required
status check is not in the YAML.

`TODO` / `FIXME` / `HACK` in `packages/` is enforced at zero. `as any` in
`packages/` is zero in this scan. One `@ts-expect-error` sits in
`packages/worker/src/origin-handler.ts` for workers-oauth-provider issue 71.
Remix is pinned at `3.0.0-rc.2` and `agents` at `0.22.0` in
`packages/worker/package.json`. Treat those upgrades as fleet deploys. Local
multi-worker dev remains a tax: secondary env-name suffixes, remote AI binding,
and `.env` secrets that do not propagate. The skill is
`.agents/skills/testing-multi-worker-dev/SKILL.md`. Test env does not start
platform and runtime. That is documented, not a surprise.

Isolation tests exist by name: `runtime-isolation.node.test.ts`,
`storage-capability-isolation.workers.test.ts`,
`inbound-account-isolation.workers.test.ts`. Billing and OAuth tests exist
(`stripe-webhooks.workers.test.ts`, `oauth-handlers.workers.test.ts`). This
review did not claim a missing auth or billing test file. The missing test is
the H2 symbol-steal case (S3).

`gh issue list --label friction --limit 20` returned no open issues.

## Docs and operator runbooks

Runbooks that still match the code: origin owns no Durable Objects
(`docs/contributing/rollback.md`, platform and runtime and jobs migration
runbooks, ADR 0034), values drain (reads remain, tables not dropped, live counts
frozen at 2026-08-24 in the values retirement runbook), invocation tokens
(unadvertised drain, do not drop tables). Environment-variable docs name Stripe
and Discord secrets without values.

### X1 — P2 — Disaster-recovery evidence is stale, by the runbook's own log

**Evidence.** `docs/contributing/disaster-recovery.md` last live evidence is
2026-08-07. Graduated production restore, automated Mailbox re-import, and
weekly retention aging are explicitly unproven. Rollback correctly says not to
cancel `deploy-production` mid-migration.

**Blast radius.** Restore, not the happy-path deploy.

**Next step.** A dated drill. Do not rewrite the doc to hide the gap.

**Needs Kent?** Yes. Solo operator time.

**False-positive risk.** Low if read as "the doc admits the gap." High if read
as "backup code is missing."

### X2 — P3 — A few docs lag the tree

`docs/contributing/code-health-receipts.md` (2026-08-30) says `as any` is 1 and
cites 45 decision records. This scan: `as any` is 0 in `packages/`, and
`docs/contributing/decisions/` has 52 numbered records besides
`0000-template.md` and `index.md`. ADR 0046 still allows leftover "community
listing" copy; `docs/use/privacy.md`, `docs/use/community-packages.md`,
`docs/use/search.md`, and `docs/use/packages.md` still say that. The phrase is
allowed. It is still drift relative to "Community is the catalog."

**Next step.** Refresh the receipt the next time someone is already in that
file. Do not start a copy sweep for "community listing" unless a usage-doc pass
is already open.

**Needs Kent?** No.

## Otherwise

**Packaging.** Root and `packages/worker/package.json` are `"private": true`.
The app is not an npm product. MCP registry publish is a separate workflow on
`server.json` changes. ADR 0046: Community is the catalog. ADR 0018 plus
`.github/workflows/cla.yml` covers inbound contributions to this repo. The
README says public packages do not use that CLA.

**Pricing.** See U4. The public ladder matches `planLimits`. Unique-worker days
and Durable Object rows-read are includes with overage, not hard cuts. Execute
and outbound weekly caps are enforced in `consumeDailyEntitlement`. Free and
public Standard job floors are 15 minutes; faster existing jobs are
grandfathered. Legacy Standard and Pro are not billed on the new meters. That
split is in the pricing footnote and in `legacyPlanLimits`.

**Discord.** See U3. The sharp edge is role identity, not login. Join is
best-effort so a Discord outage cannot block sign-in. That tradeoff is the right
one for a personal assistant. The role mapping is the part that lies.

**Open friction issues.** None at review time.

## Non-findings

- No P0. Per-user isolation on the paths checked (Durable Object names, memory
  vector namespace plus metadata filter, platform-account delegation, package
  credential stripping) holds.
- `communityForkAdopt` from background and package-app callers is gated. Tests
  in `adopt.node.test.ts` cover that refusal. The residual is S4.
- Feature flags are code, not the database. Six live keys. Authenticated
  evaluation fails closed. `compute-overage-charging` is the billing kill switch
  and defaults on, which matches its comment.
- `assertWithinEntitlement` has callers on repos, packages, jobs, sessions,
  email, secrets, workflows, and storage, with node and workers tests. Stored
  plan garbage throws. `max` cannot come from Stripe.
- Deploy does not cancel an in-flight migration. Origin production exports are
  guarded. A passing origin execute smoke does not claim to prove MCP execute.
  The architecture index and the heartbeat code agree.
- No-flash navigation is real on account and docs shells (`createRouteData`). Do
  not "fix" loading by clearing the previous page. The webhook settings blank
  (U5) is the exception that violates that rule.
- Job occurrences are fenced by a conditional claim plus an idempotency key.
  Webhook and email consumers have dead-letter queues. Account deletion is
  fail-closed.
- Search and execute return host-visible errors. Public tools stay two.
- Historical Durable Object migrations in `wrangler.jsonc` are replay history,
  not live classes.

## Suggested 30 / 60 / 90

These are ordered waves, not calendar estimates.

**First wave.** Close the P1s that are mechanical, and force the two product
calls that unblock the rest.

- S3: hide the secret-authority runner. Add the steal test.
- C1: cap package SQL rows.
- S1: Kent decides whether admin MCP is allowed from background packages. If
  not, strip roles unless the caller is an explicit operator tool.
- S2: Kent decides the default `usage_mode`. If the answer is "packages," change
  the column default and the create path. Existing `any` rows stay until the
  owner locks them.
- R2: delete the job vector before the row.
- U1: audited unban, or a documented SQL procedure plus delete the dead
  function.

**Second wave.** Consent inventory and the quiet-failure alerts.

- S4: `directMcpOnly` (or equivalent) for adopt, publish, delete, and share.
- R1: retry ceiling and claim release on non-transient job failures.
- O1: operator alerts for dead-letter depth and Vectorize or AI errors. Not
  public status cards.
- C2: lazy git on `RepoSession`, lazy `marked` on origin, then re-profile.
- C5: mailbox metadata list.
- S5: hub token cipher, or an accepted residual in `security.md`.
- U2: fail destructive admin writes when the audit sink does not persist.
- U3: Discord roles from the effective plan, if Kent wants that.

**Third wave.** Cost shape, maintainability, and drills. Do not start these
while the first wave is open.

- C3: search rate-limit cache, with the onboarding stamp still correct.
- C4: AI Gateway billing confirmation. No user meter unless the pricing page
  should say so.
- D1: shrink-only line ratchet, starting with `run-log-do.ts` and
  `repo-session-do.ts`.
- U5: accessibility pack from the 2026-09-16 list.
- X1: dated disaster-recovery drill.
- D2: one import cycle, then extend the lint.
- S7: IP hosts, reply-From, HTML-escape authorize errors.
- R5: stop minting invocation tokens if the drain should be able to reach zero.
- Onboarding events stay with the other change. O3 is the gap list, not a
  design.

Explicitly not on this roadmap: Vectorize sharding, a third MCP tool, CSRF
tokens, closing Dynamic Client Registration, a general sandbox SSRF denylist,
and a Teams product.
