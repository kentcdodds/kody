# Full platform audit — 2026-09-19

Point-in-time review of `kentcdodds/kody` for a founder/CTO skim and an engineer
deep-dive. This is an audit, not a requirements list and not a refactor plan. It
does not invent production numbers.

**Tree.** `main` at `13f5efa98c1770a3ef5ae20f526fd15d7dd7765d` (2026-09-19,
"Fold package identity into export search, top-K close exports, adaptive Jev
keep", #2381).

**Relationship to the 2026-09-16 audit.**
[`2026-09-16-codebase-audit.md`](./2026-09-16-codebase-audit.md) covered
security, accessibility, and a few performance paths, and shipped the
`communityForkAdopt` package-runtime gate. This pass rechecks those residuals,
then samples reliability, tenancy, cost, observability, product coherence, and
operator readiness. It does not re-walk the browser for accessibility.

**Method.** Read project intent, the architecture index, security invariants,
and the decision-record veto list before scoring. Sampled hot paths in source:
search/Jev, secret authority, package capability exposure, storage SQL, account
deletion, jobs, queues, Stripe refresh, UserMeter, RunLog retention,
RepoSessionIndex, entitlements enforcement, feature-flag evaluation, health.
Parent verification of every P1 and of the P2s named in the top 10. No Sentry
project, Cloudflare bill, Analytics Engine query, or `wrangler check startup`
was run. Where a number would be useful, the report says how to measure it.

**Overall.** No P0. No sampled path reads another user's data without one of the
documented exceptions. The product is in better shape than the size of the tree
suggests: isolation, OAuth token persistence, entitlement consume on the billed
paths, and the Jev gates are careful. The velocity of the last 48 hours is
search ranking (#2359–#2381). That surface is default-off and paid-only. The
risks that should not wait on a product meeting are the secret-authority runner
and the storage SQL cap. The product meeting that unblocks a cluster is "which
capabilities may a running package exercise as the owner, including admin tools
and connected accounts, and which invocations count as an execute?"

## Executive summary

Ranked by severity times leverage. P0 is remote cross-user takeover or a
credential leak to another account. None of those showed up.

| Rank | ID  | Sev | Needs Kent | One line                                                                                                                                                                                              |
| ---- | --- | --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | F2  | P1  | No         | Sandbox secret-authority runner is still stealable via well-known symbols. Same-user, not cross-user.                                                                                                 |
| 2    | F1  | P1  | Yes        | `storage.sql` materializes the full cursor, and a read skips the storage-byte check. One query can reset that user's runner and burn Durable Object rows before any monthly cut.                      |
| 3    | F16 | P1  | Yes        | Jobs, workflows, retrievers, and `packages.invoke` load admin roles. Hosted package apps do not. An admin-owned package can call admin MCP.                                                           |
| 4    | F4  | P2  | Yes        | Package runtimes still inherit almost the full capability map, and new OAuth / remote MCP connections default to `usage_mode = any`. Adopt is gated except on interactive execute.                    |
| 5    | F5  | P2  | Yes        | Jev Score is correctly off and paid-only. Before any wide flip: no timeout, error paths drop token usage, in-execute search is invisible to Analytics Engine, and pools of 8 or fewer skip the clash. |
| 6    | F6  | P2  | No         | Scheduled jobs retry transient failures forever. A non-transient throw aborts the rest of that alarm.                                                                                                 |
| 7    | F7  | P2  | Yes        | Dead-letter queues are declared and not consumed. Ack webhooks already returned 202.                                                                                                                  |
| 8    | F8  | P2  | Yes        | Inbound webhooks and other package exports are not under the execute daily cap. HTTP rate limit is 60/min, author-raisable to 600.                                                                    |
| 9    | F9  | P2  | No         | Jobs `/health` is probed. A green page still misses queue consumers, JobManager alarms, and Vectorize/AI. The execute card is a one-hour timestamp. Bare KV 5xx/429 no longer pages Sentry.           |
| 10   | F10 | P2  | No         | Hottest entitlement path still runs three retention `DELETE`s on every consume. Mailbox list still selects bodies. `RepoSession` still statically imports `isomorphic-git`.                           |

Do F2 and F1 before a planning meeting. F3 is not a lockout: the next signup
heals a leftover tombstone on the first write lease. Hold a single product call
for F16, F4, and F8 (and the rollout criteria inside F5). Do not schedule a
Durable Object rewrite:
[code health receipts](../contributing/code-health-receipts.md) already froze
that and it is the right call.

The only doc edit in this change besides the report is F12: the entitlements
enforcement table said Max concurrent workflows is 5,000. Code says 200.

Signup-to-paid instrumentation is not a top-10 risk. What exists, and what is
missing for a conversion decision, is the section "Onboarding and growth funnel
observability" below.

## How to read a finding

- **Severity.** P0 remote cross-user or credential leak. P1 same-user
  compromise, account lockout, or unbounded cost on a path a package can hit
  today. P2 real, bounded, or behind a default-off flag. P3 hygiene, docs, or an
  accepted tradeoff that should stay visible.
- **Next step.** `fix` is a contained change. `spike` needs a measurement or a
  product choice before code. `leave` means do not relitigate.
- **Product call.** Yes only when two reasonable product policies exist.

---

## Architecture and boundaries

Production is four product scripts plus ops workers. Origin owns zero Durable
Object classes
([ADR 0034](../contributing/decisions/0034-origin-owns-no-durable-objects.md)).
That split is the right one and it is holding: Remix/blog deploys can upload
origin without resetting platform objects. MCP `execute` resolves
`KodyFetchGateway` on the script that owns the `MCP` object (`kody-platform`).
Origin `POST /__maintenance/execute-smoke` is explicitly not MCP execute. That
distinction is documented and matches code. Do not collapse the fleet to "fix"
it.

Per-user isolation is the product invariant, not a later milestone. Sampled hot
paths keep it: saved packages are `id AND user_id`, integration token updates
bind `user_id`, Mailbox and StorageRunner names are user-scoped.
`getSavedPackageByIdAny` has no callers. `RepoSession` keyed by session id is a
documented exception, not a new hole. The four cross-user exceptions in
[project intent](../contributing/project-intent.md) (RBAC `user`/`role`,
operator system email, approved platform feedback, public-listing community
metadata) are still the list. This pass did not re-audit every SQL string.

Import boundaries are enforced in CI (`kody-custom/enforce-import-boundaries`
inside `npm run lint`). The documented remainder is real:
`docs/contributing/import-boundaries.md` says `#worker/*` to `#app/*` is not
fully covered (jobs, vectorize, community, email, webhooks, unverified purge).
That is a known hole in the checker, not a silent miss.

Capability domains, `getStaticRegistry()`, and the search entity-plugin split
are the right shape for a compact MCP surface (search plus execute, not a tool
catalog). Decision records are used as a veto list. That is healthy. Do not add
a new primitive to "clean this up."

**Maintainability concentration, not a rewrite ticket.** Production modules with
no line budget, measured this pass:

| Lines | File                                                 |
| ----- | ---------------------------------------------------- |
| 4019  | `packages/worker/src/run-records/run-log-do.ts`      |
| 3192  | `packages/worker/src/repo/repo-session-do.ts`        |
| 2144  | `packages/worker/src/community/service.ts`           |
| 2097  | `packages/worker/src/package-runtime/package-app.ts` |
| 2080  | `packages/worker/src/account/export.ts`              |
| 1915  | `packages/worker/src/entitlements/user-meter-do.ts`  |
| 1818  | `packages/worker/src/app/account-deletion.ts`        |
| 1813  | `packages/worker/src/jobs/service.ts`                |
| 1810  | `packages/worker/src/mcp/executor.ts`                |

The client-route and node-test ratchets are empty and doing their job
(`tools/file-size-ratchet.json` budgets 800 and 2,000). Production source is
outside that ratchet on purpose. Next time a bug lands in one of these files,
peel the behavior you are already touching. Do not open a split program.

---

## Reliability and correctness

### F3 — A failed tombstone clear is logged and healed, not a lockout

- **Severity:** P3. Earlier draft of this report scored this P1. That overstated
  the next signup.
- **Product call:** No
- **Next step:** Leave. Optional: send the existing console error to Sentry.
- **Evidence:** After the user row is deleted, `deleteUserAccount` calls
  `clearUserMeterDeletionTombstone` and swallows a throw
  (`packages/worker/src/app/account-deletion.ts`, the block whose comment starts
  "The D1 user row is gone"). The comment describes the fence the clear exists
  to remove. It is not what the next signup hits. `withAccountWriteLease` treats
  a live D1 row plus a meter tombstone as a leftover fence, clears it, re-checks
  D1, and acquires again (`packages/worker/src/account/deletion-state.ts`, the
  block that starts "Live D1 + meter tombstone"). Covered by
  `withAccountWriteLease drops a leftover UserMeter tombstone when D1 is live`
  in `packages/worker/src/account/deletion-state.node.test.ts`. New accounts
  reuse `SHA-256(lowercase email)` as `stable_user_id`
  (`packages/worker/src/user-id.ts`), so the object is the same. `/mcp` `search`
  does not take the lease (`jsonRpcMessageNeedsAccountWriteLease` returns false
  for `search` in `packages/worker/src/mcp-auth.ts`) and only checks D1. `/mcp`
  `execute` takes the lease, so the first execute heals.
- **Blast radius:** One extra UserMeter RPC on the first write lease after a
  failed clear. `console.error` is
  `account_deletion_user_meter_tombstone_clear_failed`. An operator is not
  required.
- **Recommendation:** Keep the clear. Do not fail the deletion response after
  the user row is gone: that response cannot retry the D1 delete, and the lease
  path is the backstop. The ordering before the clear is sound: inventory and
  Stripe cancel fail closed, warnings abort before the user row is deleted,
  Mailbox waits on R2, jobs purge is idempotent.

### F6 — Jobs have no poison ceiling

- **Severity:** P2
- **Product call:** No
- **Next step:** Fix
- **Evidence:** `computeJobRetryAt` delays `min(5 minutes, 5s * 2^retryCount)`
  and never stops (`packages/worker/src/jobs/execution-safety.ts`,
  `jobRetryMaximumDelayMs`). `runDueJobsForUser` calls `retryClaimedJob` on
  `TransientJobExecutionError` with no retry cap
  (`packages/worker/src/jobs/service.ts`). Any other throw leaves the `catch`
  and aborts the rest of that alarm invocation. Occurrence idempotency
  (`scheduled-job:{jobId}:{scheduledFor}`) still prevents a successful
  occurrence from running twice. `maxDueJobsPerAlarm` is 25.
- **Blast radius:** One user's `JobManager`. Other users are separate objects. A
  poisoned job keeps waking that object every five minutes. A hard throw delays
  the other 24 due jobs until the alarm retries.
- **Recommendation:** After a fixed retry count, finalize the occurrence as
  failed and continue the batch. Keep the claim fence.

### F18 — Job delete removes the row before the vector

- **Severity:** P2
- **Product call:** No
- **Next step:** Fix
- **Evidence:** `deleteJob` awaits `jobsData().deleteJob`, then
  `deleteJobVector` (`packages/worker/src/jobs/service.ts`). The package-job
  sync loop does the same. Account deletion rebuilds vector ids from rows that
  still exist (`listJobIdsForUser`). A vector left behind is invisible to that
  purge. A retry of the failed delete hits "not found" and does not clean the
  index.
- **Blast radius:** That user's search can still return a deleted job. Same
  user. Not a cross-user leak.
- **Recommendation:** Delete the vector, or write a cleanup debt row, before the
  job row is removed.

### F7 — Dead-letter queues are sinks

- **Severity:** P2
- **Product call:** Yes, on page versus replay
- **Next step:** Spike
- **Evidence:** Origin consumers set `dead_letter_queue` for email delivery,
  webhook dispatch, package events, community activity, platform feedback, and
  artifacts repo events (`packages/worker/wrangler.jsonc`). `handleQueueBatch`
  switches only on the live queue names
  (`packages/worker/src/queue-handler.ts`). Nothing consumes
  `kody-webhook-dispatch-dlq` or `kody-email-delivery-dlq`. Webhook HTTP ack is
  202 before the consumer finishes. Unmatched email delivery events retry, then
  sit in the DLQ, so a bounce that arrives before the outbound row is visible
  can miss the abuse pause.
- **Blast radius:** That delivery or bounce. Not a fleet outage. The provider
  already has a success ack for webhooks that later DLQ.
- **Recommendation:** A consumer that records a terminal failure and is visible
  to the operator. Do not silently replay user-effecting package code. Kent
  decides whether a DLQ row pages or waits for `/admin` inspection.

### F11 — Stripe plan refresh can drop a newer alarm

- **Severity:** P2
- **Product call:** No
- **Next step:** Fix
- **Evidence:** `StripePlanRefreshBase.schedule` writes the user id and
  `setAlarm`. `alarm` awaits Stripe inside `withAccountWriteLease`, then
  `deleteAll()` on success
  (`packages/worker/src/billing/stripe-plan-refresh-do.ts`). Neither method uses
  `blockConcurrencyWhile`. An awaited outbound fetch opens the input gate, so a
  `schedule()` during that await can be wiped by the later `deleteAll()`.
- **Blast radius:** One customer's plan stays stale until the next webhook.
  Refresh itself is idempotent. Not a double charge by itself.
- **Recommendation:** Hold the input gate across `schedule` and `alarm`, and
  delete storage only if no newer alarm was set.

### F14 — RepoSessionIndex reschedules a failing cleanup for now

- **Severity:** P2
- **Product call:** No
- **Next step:** Fix the backoff. Spike the full scan only if session counts
  grow.
- **Evidence:** `scheduleNextDue` loads `SELECT * FROM repo_sessions` with no
  limit (`listStoredRows`). `runDueCleanup` logs per-session errors and still
  calls `scheduleNextDue`. `alarmAt = max(dueAt, now)`, so a session that stays
  due wakes immediately (`packages/worker/src/repo/repo-session-index-do.ts`).
  The jobs lane `repo_session_cleanup` is the five-minute backstop, so this is
  amplification, not a stuck product. Same shape as the RunLog 1s spin that
  #2331 already fixed.
- **Blast radius:** One owner's index Durable Object.
- **Recommendation:** Back off on `errors > 0`. Leave the cron.

### RunLog retention — the 1s spin is fixed; idle ledger drain is the leftover

#2331 landed. Empty retention passes back off from 15s to 15 minutes
(`runRecordRetentionEmptyBackoffMinMs` / `MaxMs` in
`packages/worker/src/run-records/types.ts`). `alarm` treats a pass as empty when
`runDeletes === 0` (`packages/worker/src/run-records/run-log-do.ts`).
`pruneInvocationLedgerForRetention` deletes at most 100 terminal ledger rows in
the same pass and does not increment `runDeletes`. If the oldest terminal ledger
row is already past the 90-day cutoff, `nextRetentionDueAtMs` is in the past, so
the empty backoff applies even though the pass made progress.

- **Severity:** P3
- **Product call:** No, unless a real user's RunLog storage bill shows this
- **Next step:** Spike. Count ledger and workflow deletes as progress before
  applying the empty backoff.
- **How to measure:** Per-user Durable Object storage and `rows_written` on
  `RunLog` for users with large `package_invocation_ledger` tables. This report
  has no production sample.
- **Do not regress:** Active traffic still prunes on the finish path. Unvisited
  objects do not alarm. In-progress ledger rows are not age-pruned. Those are
  correct.

### Other reliability notes (not top 10)

- **OAuth purge** is one small page per five-minute cron, checkpointed after the
  step. Deletes are idempotent. A large `OAUTH_KV` drains slowly. Leave unless
  key count is a known problem. No production count in this review.
- **Feature-flag evaluation** matches the documented rules. Sticky bucket is
  `fnv1a32(key + userId) % 100`. Overrides win. `experiments_opt_in` is an AND
  after rollout, not "N% of opted-in users." Unknown audiences normalize to
  `everyone` on read. #2376 (admin Audience `<select>` showing Everyone) is
  fixed in this tree: options set `selected`.
- **Account deletion ordering** before the tombstone clear is the part that
  looks healthy. See non-findings.

---

## Security, tenancy, secrets, OAuth, MCP

Accepted residuals in `docs/contributing/security.md` are not reopened: open
`/oauth/register`, CSRF via `SameSite=Lax` plus JSON, stateless cookies, no
step-up on secret reveal, signup enumeration, PBKDF2-SHA256 100k, non-secret
sandbox fetch without an SSRF denylist, webhook HMAC opt-in, same-owner package
apps on one subdomain, unverified social reclaim. Invariant 15 (package runtimes
cannot adopt or grant themselves secrets) holds for background origins. The hole
left is interactive `execute`.

### F2 — Secret-authority runner is still on a well-known symbol

- **Severity:** P1
- **Product call:** No
- **Next step:** Fix
- **Evidence:** `createRuntimeModuleSource` still installs
  `Symbol.for('kody.getSecretAuthority')` on `globalThis` and hangs
  `Symbol.for('kody.runWithSecretAuthority')` on that function
  (`packages/worker/src/package-runtime/runtime-source-modules.ts`). The getter
  is non-writable. `Object.getOwnPropertySymbols` still returns the runner. Host
  policy accepts a package id that is already in the run's grant set
  (`packages/worker/src/mcp/secrets/secret-authority.ts`). Importing package A
  puts A in that set. Workers tests read the getter and deny unstamped reads.
  They do not call the stolen runner with A's id.
- **Blast radius:** Same user. If B imports A, B can stamp itself as A for
  `packageSecrets` and `{{secret}}`. If A is self-authored, implicit read covers
  the owner's secrets, not only A's allowlist. Not cross-user. Not a live PoC in
  this review; the symbols are reachable from the source.
- **Recommendation:** Keep the runner in a closure the bundler wrapper holds. Do
  not put it on any user-reachable object. Add the steal test the 2026-09-16
  audit already specified.

### F16 — Background package callers load admin roles

- **Severity:** P1
- **Product call:** Yes. The load is commented as intentional so an admin
  owner's packages can see `admin_*` tools. Hosted package apps do the opposite.
- **Next step:** Spike only the policy. The code change is small once Kent picks
  it.
- **Evidence:** `loadBackgroundMcpUser` loads roles and permissions. The comment
  says omitting roles hides `admin_*` tools even for admin owners
  (`packages/worker/src/identity/background-mcp-user.ts`). Callers include
  `packages/worker/src/jobs/service.ts`,
  `packages/worker/src/package-runtime/package-workflows.ts`,
  `packages/worker/src/package-runtime/realtime-session.ts`, and
  `packages/worker/src/package-retrievers/service.ts`.
  `callerCanAccessCapability` checks role, permission, and feature flag. It does
  not check `executionOrigin`
  (`packages/worker/src/mcp/capabilities/access-control.ts`).
  `adminCapabilityAccess` is `requiredRole: 'admin'` only
  (`packages/worker/src/mcp/capabilities/admin/admin-shared.ts`).
  `PackageAppRuntimeBridge.createCallerContext` sets id, email, and display name
  and leaves `roles` unset
  (`packages/worker/src/package-runtime/package-app.ts`), so hosted package apps
  do not see admin tools.
- **Blast radius:** A job, webhook, workflow, retriever, or `packages.invoke` on
  an admin-owned package, including a community fork that admin installed. Not
  other users. Not the hosted package-app HTTP bridge.
- **Recommendation:** Do not copy admin roles onto background package callers
  unless the package is an explicit operator tool. Owning the package is not
  that tool.

### F4 — Packages still act as the user for consent-sensitive capabilities

- **Severity:** P2
- **Product call:** Yes. This is the model. "A package is the user" is a legal
  product sentence. It is inconsistent with the gates that already exist.
- **Next step:** Spike the allowlist, then fix. Do not invent a blanket ban on
  `kody.*` from packages. Email, storage, and fetch are supposed to run there.
- **Evidence:** `buildKodyFns` maps the registry onto `kody.*` with no omit list
  (`packages/worker/src/mcp/run-kody-registry.ts`). There is still no
  `directMcpOnly` symbol in source. `executionOrigin` gates exist on
  `communityForkAdopt`, `packageAppFetch`, `packageSubscriptionDispatch`,
  platform-feedback submit, and external-publish escalation. They do not exist
  on `packageDelete` (`confirm_name` only), `communityPublish`,
  `packageShareInvite`, `communityUnpublish`, `webhookUrlRotate`,
  `webhookUrlMint`, `secretSet`, `secretDelete`, `secretProviderBind`, or
  `secretProviderUnbind`.

  **Adopt residual (H1).** Background package apps fail the gate
  (`executionOrigin: 'background'` plus a storage context in
  `packages/worker/src/package-runtime/package-app.ts`). Interactive MCP stamps
  `executionOrigin: 'interactive'` and no storage context
  (`packages/worker/src/mcp-auth.ts`). `execute` passes that caller through.
  Imported package code in that run can still call `communityForkAdopt`.

  **Secret providers (flag default off).** `secretProviderBind` has no origin
  check
  (`packages/worker/src/mcp/capabilities/secrets/secret-provider-bind.ts`). Bind
  itself does not return secret values. It requires an owned package whose
  manifest `kody.secretProvider.id` matches, then checks that the door-key name
  exists. Once that package is the binding, `resolveCanonicalProviderRef` passes
  `doorSecretValue` into the package **before** `assertProviderGrant`
  (`packages/worker/src/mcp/secrets/secret-providers/service.ts`). The provider
  package is supposed to see the door key after a legitimate bind. The gap is
  that a running package can retarget the binding without an interactive caller.
  The flag is off by default and user-toggleable from the docs page. Non-secret
  `fetch` can then carry the key out (accepted SSRF residual).

  **Connected accounts default to every package.** `usage_mode` is
  `NOT NULL DEFAULT 'any'` on `user_integrations`
  (`packages/worker/migrations/0026-integration-owned-credentials.sql`) and
  `mcp_server_settings`
  (`packages/worker/migrations/0031-mcp-server-package-usage.sql`).
  `assertCanUseIntegration` returns immediately when the mode is `any`
  (`packages/worker/src/integrations/package-access.ts`). New MCP server rows
  are inserted as `any` (`packages/worker/src/mcp-client/settings-service.ts`).
  An unadopted fork can be denied user secrets and still call
  `createAuthenticatedFetch` or `kody.mcp[...]`. This is not an accepted
  residual in `security.md`. It is the same product sentence, applied to
  third-party accounts.

- **Blast radius:** One owner's packages, and, when `usage_mode` is `any`, that
  owner's connected accounts and remote MCP servers. If secret providers are on,
  the door key too. Not cross-user.
- **Recommendation:** One shared interactive-only check, applied to the consent
  list Kent names. Minimum if he does not want a meeting: omit
  `communityForkAdopt` from sandbox `kody.*`, and gate `secretProviderBind` /
  `secretProviderUnbind` the same way as `secretLock` (website approval, no
  grant from package code). `secretLock` and `secretProviderLock` still do not
  write grants. That part is healthy.

### Carried security items, still open, not re-scored upward

| ID  | Sev | Item                                                                                                                                                                                              | Still true?                                                                                      |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| M2  | P3  | Secret host approval accepts canonical IPv4/IPv6, including `[::1]`, with no private/link-local denylist (`approval-host-shape.ts`). The UI shows the host. Confused-deputy via an approval link. | Yes. Tests expect those addresses.                                                               |
| M3  | P2  | Missing Authentication-Results fails open. Reply prefers Reply-To, then header From, and does not consult the verdict (`email/auth-verdict.ts`, `email/outbound.ts`).                             | Yes. Overlaps the documented email residual. Cloudflare may already reject double-fail SPF+DKIM. |
| L1  | P3  | Avatar POST treats any non-JSON body as `FormData`. SameSite keeps it non-exploitable today.                                                                                                      | Yes.                                                                                             |
| L2  | P3  | OIDC logout clears the session on GET. `post_logout_redirect_uri` matches a registered client. Open DCR is accepted.                                                                              | Yes.                                                                                             |
| L3  | P3  | `standaloneAuthorizeErrorHtmlResponse` interpolates `message` and sets no CSP (`oauth-handlers.ts`). Current error strings are static.                                                            | Yes.                                                                                             |
| L4  | P3  | Resend-verification sends mail without requiring JSON. Rate-limited. SameSite blocks cross-site POST cookies.                                                                                     | Yes.                                                                                             |

### Security non-findings (do not relitigate)

- MCP OAuth `iss` is stamped on client redirects (2026-09-16 N1). Not re-opened.
- User-integration refresh uses `COALESCE` so an omitted `refresh_token` does
  not wipe the stored one (`packages/worker/src/integrations/repo.ts`). MCP
  client `saveTokens` merges a prior refresh token. Park logs are booleans and
  ids, not token values.
- Secret-bearing sandbox fetch checks the host after placeholder expansion and
  forces `redirect: 'manual'` when the caller asked to follow
  (`packages/worker/src/mcp/fetch-gateway.ts`).
- `/mcp` requires a bearer whose audience is the origin or `${origin}/mcp`.
  `kody_session` is `httpOnly`, `sameSite: 'Lax'`.
- Webhook URL secrets are SHA-256 then constant-time compared, including the
  previous hash during rotation. Retirement happens only after the new URL is
  accepted. Docs and code match. HMAC remains opt-in.
- First-party HTML still goes through `render()` and the strict CSP. Package
  apps stay on their own origin without that CSP. Invariants 1, 2, and 9 hold in
  the paths sampled.
- PKCE stays S256-only.

---

## Performance and cost

No production bill, Workers AI usage, or Durable Object rows-read dashboard was
queried. Comments that quote a dollar figure are comments.

### F1 — Storage SQL is unbounded, and reads skip the byte entitlement

- **Severity:** P1
- **Product call:** Yes, only on whether reads stay "soft billed." The row cap
  is not optional.
- **Next step:** Fix the cap. Spike the billing policy.
- **Evidence:** `cursorToSqlResult` calls `cursor.toArray()` with no limit and
  no `truncated` flag (`packages/worker/src/storage-runner.ts`). KV `listValues`
  is paged at the caller's page size. `packageStorage().sql` always passes
  `writable: true` so CREATE/INSERT work, then `isReadOnlyStorageSqlQuery` skips
  `assertWriteWithinEntitlement` for a single `SELECT` / `EXPLAIN` / schema
  `PRAGMA`. That skip was added so SELECT-heavy exports would not time out on an
  all-bucket byte fan-out. It also means a `SELECT` never hits the byte check.
  `rowsRead` is recorded after the scan on the `durable_object_rows_read` meter.
  Public plans can invoice overage later. Legacy monthly meters are
  `no_cut_no_bill`. Max is not a hard cut
  (`packages/worker/universal/plans.ts`).
- **Blast radius:** That storage id's runner (`SQLITE_NOMEM` resets the isolate,
  same class as UserMeter lease failures). Operator Cloudflare rows-read. Not
  cross-user.
- **How to measure:** Sum `durable_object_rows_read` per user from
  `kody_usage_events`, and watch StorageRunner reset reasons in Workers Logs.
  This report has neither number.
- **Recommendation:** Cap at the export page size (1,000) or abort on a
  `rowsRead` budget before `toArray()` returns to user code. Document the cap.
  Do not put the all-bucket byte fan-out back on every SELECT.

### F5 — Jev is gated correctly and not ready for a wide flip

- **Severity:** P2 while the flag stays off. Becomes the cost item the day an
  operator sets audience `everyone` or `experiments_opt_in`.
- **Product call:** Yes, for three policy choices below. Not for the missing
  timeout.
- **Next step:** Spike the measurement gaps before rollout. Fix the timeout and
  the dropped usage on the error path as part of that spike, not after the flag
  is on.
- **How ranking works today.** List-mode search is hybrid lexical plus vector
  (reciprocal rank fusion, then intent boosts in `search-scoring.ts`). Jev Score
  is a later filter, not the retriever
  (`packages/worker/src/mcp/tools/search-jev-rerank.ts`). Gate order in that
  file's header matches the code: flag, paid plan, empty pool, offline, no `AI`
  binding, necessity, then Score. Model string is `typesafe/jev`. It requires
  `AI_GATEWAY_ID` and does not fall back to direct Workers AI. Embeddings
  (`@cf/baai/bge-small-en-v1.5`) do fall back. Those are different models on
  purpose.
- **Who can spend it.** Free and anonymous cannot. Anonymous callers fail closed
  to every flag off. The registry default of `jev-search-rerank` is off.
  Experiments opt-in does not turn the flag on. A per-user override does.
  Necessity: pools of 8 or fewer skip; pools of 9–20 run only on a tight score
  gap, mixed types, or a parent/export clash; pools over 20 always run. Keep is
  adaptive (1.5, else 0.75 within 0.5 of the top). Low mean confidence restores
  hybrid. A confident weak score returns a true empty list and does not restore
  hybrid noise.
- **What is not bounded.** No `AbortSignal` and no per-search deadline. Worst
  case is 5 parallel `AI.run` calls (cap 40 cards, batches of 8). Each batch
  sends the full candidate state, not only that batch. On any throw, the catch
  restores hybrid and reports null token usage even if sibling batches already
  ran. The `$0.0009` / `$22.50` lines in `search-rate-limit.ts` are a comment
  (`25_000 * 0.0009`). They are not a measured bill, and they do not account for
  five full-state batches.
- **Rate limits** (`packages/worker/src/search-rate-limit.ts`), per signed-in
  user, D1 sliding windows, consumed before embeddings:

  | Plan     | Burst / 60s | Daily  |
  | -------- | ----------- | ------ |
  | free     | 80          | 1,000  |
  | standard | 160         | 5,000  |
  | pro      | 200         | 10,000 |
  | max      | 240         | 25,000 |

  Entity lookups do not consume the limit and do not call Jev. Failure is
  `rate_limited`, not `entitlement`, with copy that says back off rather than
  upgrade. That is the right shape. `retryAfterSeconds` is the full window, not
  time until the oldest row expires. The daily key stores one D1 row per search,
  up to 25,000 for Max, and `COUNT(*)`s it. Leave the ceilings. Spike row volume
  before raising Max.

- **Small-pool clash.** `evaluateJevSearchNecessity` returns
  `skipped-small-pool` before `hasParentPackageExportClash`. #2381 folded
  package identity into export lexical fields and promoted close exports. That
  clash often lives in a pool of 8 or fewer, which is exactly the case that
  never calls Jev. Medium pools do run on the clash. This is latent while the
  flag is off.
- **Adaptive keep.** If the package index scores at least 1.5 and the export
  does not, only the index is kept. The secondary floor never runs. Cards past
  40 are never scored. The user still gets the index and nested action hints,
  not a fabricated call contract. Sibling exports that both survive still block
  the inlined contract. That last rule is correct. Keep it.
- **Observability gap.** Public `search` writes Analytics Engine
  `MCP_SEARCH_EVENTS` with outcome, cohort, tokens (missing stored as `-1`, not
  zero), and no user id or query text. `keepPath` is not a field. In-execute
  meta `search` returns `telemetry.jevRerank` and does not write that dataset.
  Error fallback zeros usage. The flag's success metric is `execute` event
  count, not rank quality or tokens
  (`packages/worker/universal/feature-flags/registry.ts`). You cannot judge a
  rollout from the success metric as registered.
- **How to measure, from data that exists today:** on `kody_mcp_search_events`,
  filter `blob6` (`jevOutcome`), sum `double16`/`double17` only where `>= 0`,
  count `double15` (`aiCallCount`) where `>= 0`. Index `mcp_search`. That still
  undercounts meta-capability searches and failed batches.
- **Product choices, not defects:** whether a parent/export clash inside a small
  pool should pay for Jev; whether a confident low score should stay empty;
  whether "improved search" is judged by execute count or by outcome and token
  doubles.
- **Do not relitigate:** flag is a kill switch, plan is a feature gate, hybrid
  stays the retriever, offline never calls Jev, incomplete Score answers do not
  partially reorder, export promotion refuses identity-only hits, package
  Vectorize queries fail closed on `userId` mismatch.

### F8 — Webhooks and package exports are outside the execute cap

- **Severity:** P2
- **Product call:** Yes
- **Next step:** Spike, then either share `execute_calls_per_day` or document
  the HTTP limit plus monthly unique-worker-day overage as the intended bill.
- **Evidence:** MCP `execute` consumes the daily entitlement before the sandbox
  (`packages/worker/src/mcp/tools/execute.ts`). `dispatchWebhookInvocation`
  calls `invokePackageExport` with no `consumeDailyEntitlement`
  (`packages/worker/src/webhooks/delivery.ts`,
  `packages/worker/src/package-invocations/service.ts`). Declared webhook rate
  limit defaults to 60/min and maxes at 600 (`webhookDefaultRateLimitPerMinute`,
  `webhookMaxRateLimitPerMinute` in
  `packages/worker/src/package-registry/types.ts`). Outbound fetches from the
  sandbox still hit the fetch gateway meter. Unique worker-days are observe or
  overage, not a hard cut.
- **Blast radius:** Operator Dynamic Worker spend for one account, up to the
  HTTP ceiling, until a monthly overage invoice. A free account is not hard
  stopped the way an execute loop is.
- **How to measure:** `dynamic_worker_days` and webhook delivery counts per
  user. Not queried here.

### F10 — Hot-path Durable Object cost that is still on the consume path

- **Severity:** P2 as a cluster. Each item alone is a small constant. Together
  they sit on paths that run on every execute, email, and mailbox page.
- **Product call:** No
- **Next step:** Fix UserMeter retention off the consume path. Spike mailbox
  columns. Route git through the lazy loader that already exists.
- **Evidence:**
  - `UserMeterBase.deleteStaleCounters` runs three `DELETE`s (daily counters,
    inbound delivery claims, dynamic worker days) on `consume`, and also on
    read, refund, and initialize
    (`packages/worker/src/entitlements/user-meter-do.ts`). Retention is 7 days.
    Most deletes match zero rows. This is the 2026-09-16 L5 item, still open. No
    production CPU number.
  - Mailbox list/search still `SELECT *` including bodies, then the account UI
    drops them (2026-09-16 M4). Not re-measured. The cost is operator rows and
    RPC size, not the customer `durable_object_rows_read` meter (that meter is
    StorageRunner).
  - `packages/worker/src/repo/repo-session-do.ts` still
    `import rawGit from 'isomorphic-git'`. `isomorphic-git-lazy.ts` exists
    because a static import re-eagerizes the library. Platform startup sits
    closer to the upload ceiling. Not re-profiled with `wrangler check startup`
    this pass.
  - `marked` is still a static import in
    `packages/worker/src/app/highlight-code.ts`, reached from account activity,
    jobs, onboarding, and package files. Startup impact not re-measured.
- **Recommendation:** Throttle UserMeter deletes to once per UTC day in DO meta.
  Metadata-only mailbox list. `loadIsomorphicGit()` inside RepoSession methods.
  Do not block the P1s on these.

### Search abuse ceiling versus other `AI.run` callers

Only two `AI.run` sites were found: embeddings and Jev. Memory search and
package reindex can embed without the MCP search ceiling. Reindex is
operator/fleet. If memory embed is user-triggered and hot, put a ceiling on it.
This pass did not count memory-search QPS. Leave search itself off the
`/pricing` resource table until you decide it is a plan include (it is an abuse
ceiling today, and the error copy says so).

---

## Observability and incident readiness

### F9 — What a green page proves, and what no longer pages

- **Severity:** P2
- **Product call:** No
- **Next step:** Fix as one operator page, not a new telemetry product.
- **Evidence:**
  - `GET /health` is a SHA and deploy card. It does not touch D1, queues, or
    Durable Objects (`packages/worker/src/app/handlers/health.ts`).
  - `GET /health/components` proves, within a short timeout and memo, `SELECT 1`
    on app and audit D1, a KV get of a missing key, an R2 head of a missing key,
    and a timestamp read of the last successful MCP execute. It does not run
    execute.
  - `status.kody.codes` being green means those probes plus the workers the
    status prober calls. The MCP execute card is "recent" if that timestamp is
    under one hour. Organic traffic keeps it green. The synthetic
    `POST /__maintenance/mcp-execute-health` runs at most once an hour, and only
    when the last minute had no organic success. Public reads never start it.
    Documented in `docs/contributing/architecture/index.md`. Code matches.
  - A green page does not prove queue consumers, DLQs (F7), JobManager alarms,
    RunLog retention, webhook HMAC, email routing, or Stripe refresh.
  - #2379 drops a bare `KV PUT|GET|DELETE|LIST failed: 5xx|429` from Sentry
    (`packages/worker/src/cloudflare-kv-platform-error.ts`, pattern is exact).
    The HTTP response is still 500. A sustained `OAUTH_KV` outage will not open
    a Sentry issue. Wrapped recovery messages still send. The status KV probe
    can still open a public incident. That split is reasonable if the operator
    knows it. It is not written on one page.
  - Server `beforeSend` also drops user code, entitlement denials, retryable D1
    locks, sandbox timeouts, OAuth refresh caller errors, Durable Object isolate
    reset, and several other classes (`packages/worker/src/sentry-options.ts`).
    Browser `sentry-browser-filters.ts` (1,488 lines) drops client junk. That
    file is large because the filters are specific. Leave it.
  - Workers Logs and OTel traces are on. Production pins the Sentry traces
    sample rate to 0 to avoid double SDK traces. Analytics Engine is metering,
    not a log store. `/admin/insights` has no search-latency chart. Search
    duration lives in `MCP_SEARCH_EVENTS` (and misses in-execute search, F5).
- **What already exists:** `docs/contributing/rollback.md` (fleet order, do not
  cancel a deploy), `docs/contributing/disaster-recovery.md` (solo operator),
  migration runbooks, `docs/contributing/operator-accounts.md` (secret names,
  not values). Status is its own worker
  ([ADR 0004](../contributing/decisions/0004-status-page-separate-worker.md)).
- **Recommendation:** One page: what still pages, which status cards map to
  which probe, health URLs, the Analytics Engine dataset names, and the sentence
  "bare KV 5xx is dropped from Sentry; look at the status `kv` card and Workers
  Logs." Do not turn the dropped KV events back on without a rate limit. KODY-7W
  was noise.

---

## Product and UX

### Entitlements are coherent, with two policy gaps

Plans are `free`, `standard`, `pro`, and `max`. Every resource in `plans.ts` is
finite. `max` is manual-only and not a Stripe SKU. `/pricing` reads `planLimits`
rather than a second copy of the numbers. Public prices ($0 /
$12 / $49 and the
yearly equivalents) live beside the table, not inside it. Overage rates match
`computeOverageRatesUsd`. Daily UserMeter consumes are revision-checked inside
the Durable Object. Email inbound and outbound are enforced (messages, bytes,
sends, receives). That was checked because it is easy to assume email is a gap.
It is not.

Row-count limits are check-then-insert and can overshoot by a few rows. The
entitlements doc calls that accepted. Leave it.

F1 and F8 are the real entitlement gaps: SQL reads, and non-execute package
invocations. Search is an abuse ceiling on purpose.

### F12 — Max concurrent workflows doc said 5,000

- **Severity:** P3
- **Product call:** No
- **Next step:** Fixed in this change
- **Evidence:** `planLimits.max.maxConcurrentWorkflows` is 200
  (`packages/worker/universal/plans.ts`). The enforcement table in
  `docs/contributing/architecture/entitlements.md` said `max` = 5,000, which is
  the Max `scheduled_jobs` cap, not workflows. The cell now says 200.
- **Do not confuse** with the inline comment on that constant ("2× pro (100)").
  Public Pro in the same file is 50, legacy Pro is 100, Max is 200. The comment
  is loose. The constant is the authority. Not worth a second doc pass.

### Experiments

`/account/experiments` sets `users.experiments_opt_in` and says joining does not
turn a flag on. That copy is true. No registry flag uses audience
`experiments_opt_in` by default. `jev-search-rerank` is dogfood via per-user
override. `package-share-grants` and `secret-providers` are default off and opt
in from their docs pages via per-user override, which bypasses the audience
gate. The admin select bug is fixed.

- **Severity:** P3
- **Product call:** Yes
- **Next step:** Leave the plumbing. Either attach the first real flag
  (`jev-search-rerank` is the obvious candidate, after F5) or keep telling
  operators the page is an audience bit with nothing targeted at it. Do not
  delete it.

### Search and execute agent DX

[ADR 0023](../contributing/decisions/0023-progressive-search-disclosure.md) is
implemented: domain index for an empty search, slim package detail, follow-up
for types and README. Default list budget is 4,000 characters; hard truncate is
6,000 tokens. Entitlement denials carry `structuredContent.entitlement`. Search
abuse carries `structuredContent.rateLimit`. Caller mistakes are
`McpCallerError` and should not reach Sentry. Compact MCP instructions are a
default-off flag because some clients keep about 2,048 characters of
instructions. That is the right constraint. Do not grow the tool catalog.

The gap agents will hit: search rate limits are invisible on `/pricing`. The
error tells them to back off. Pricing does not mention the ceiling. Leave it off
the plan table until F5's product call, then add one sentence.

### Discord, gifts, and roles

`packages/worker/src/discord/guild-role.ts` states the policy in the file
header: member role follows a connected Discord account; Standard and Pro roles
follow `users.stripe_plan`, not the effective plan (gift, referral overlay, or
manual Max). Max has no role.
[ADR 0030](../contributing/decisions/0030-discord-guilds-join-on-social-login.md)
is join-on-login. A second-agent Standard gift does not paint the Standard role.

- **Severity:** P3
- **Product call:** Yes
- **Next step:** Leave unless Kent wants the guild to match the effective plan.
  The code is explicit. This is not a bug against the file's own contract.

### F19 — Community bans have no reachable unban

- **Severity:** P2
- **Product call:** Yes, on whether unban is a product action.
- **Next step:** Fix, or document the SQL and delete the dead function.
- **Evidence:** `/admin/community-reports` calls `banCommunityUser`
  (`packages/worker/src/app/handlers/admin-community-reports.ts`).
  `unbanCommunityUser` in `packages/worker/src/community/service.ts` has no
  other callers. Neither path calls `logAuditEvent`. The report row and
  `banned_by_user_id` are the trail.
- **Blast radius:** A banned account stays banned until someone writes D1.
- **Recommendation:** An audited unban on that page, or a one-line SQL procedure
  in the operator runbook. Do not leave a function that nothing calls.

### Onboarding and waiting

One contract in `packages/worker/universal/onboarding-process.ts`: connect a
host, first search via `guide:onboarding`, second agent (same vendor family
greyed, 14-day Standard gift). Waiting is a separate queue (email verify, OAuth
reconnect, secret expiry, plan cap). First-win email is not a wizard step. Docs
match that split. Leave the wizard. The measurement gap is the funnel appendix
below, not a missing step in the wizard.

### Accessibility (carried, not re-walked)

No accessibility commits showed up between the 2026-09-16 audit and this SHA.
This pass did not run a browser or axe. Treat M7–M11 and L6 in that report as
still open until someone closes them: mobile menu Tab trap, a handful of unnamed
controls, account/admin focus on `<main>` rather than the new `h1`,
password/OAuth errors not field-associated, webhook settings clearing while the
parent page stays, success toasts at 4 seconds. None of those block a critical
task. They should not outrank F2.

---

## DX, tests, and CI

`npm run validate` is the real gate: format, lint, typecheck, node tests,
workers tests, Playwright, MCP e2e, fleet builds, startup budget, primitives,
migrations, deploy guardrails, docs checks, mermaid, slop, knip. CI runs the
same checks as separate jobs. Draft PRs skip them. Nx cache transport flakes are
absorbed after a task succeeds
([ADR 0019](../contributing/decisions/0019-self-hosted-nx-remote-cache.md),
[0040](../contributing/decisions/0040-same-repo-writers-may-put-nx-cache.md)).
Forks are read-only. That is a reasonable CI policy.
[ADR 0038](../contributing/decisions/0038-no-nx-cloud-read-write-cache-tokens.md)
says PR CI cannot poison the cache; the index now points writers at 0040. The
0038 sentence is the stale one. Not worth a finding beyond this note.

**Test shape on the hot paths.** UserMeter has a workers suite. OAuth refresh
has node and workers tests. Search has large node suites (`search.node.test.ts`
is 1,793 lines) and no Playwright coverage of the MCP search tool. Jev tests
mock `AI.run`. Search rate-limit tests mock D1. That is appropriate for
determinism and it means a gateway envelope change is caught only if the fixture
includes it. #2369 (unwrap Jev envelopes) is the kind of bug that fixture has to
keep earning. Do not add a browser test for search. Do add the symbol-steal
workers test under F2, because that is a security property node unit tests will
not see.

**Cloud agent sharp edges** are written down in
`docs/contributing/cloud-agents.md` (Node 26 on `PATH`, Playwright `io_uring`
hang, wrangler reload if `X_LOCAL_EXPLORER` is on, `dev:ensure` port hop). They
are not hidden. Leave them in that doc.

**`as any` and `TODO` counts** in the August 30 code-health page are not
re-measured here. Do not quote them as current.

---

## Docs and operator runbooks

Docs are split the way the project claims: `docs/use/` for MCP users,
`docs/contributing/` for this repo, decision records as vetoes, audits as dated
snapshots. Checkers exist (`docs:check-temporal`, decision-record numbers,
mermaid, oversized guide sections). That is ahead of most codebases this size.

**Gaps:**

- F9's missing incident card is the operator gap that matters. Rollback and DR
  are real. They are not "what page is firing at 3am."
- F12 was a one-cell lie in the enforcement table. Fixed here. The Max ladder
  elsewhere in that doc (the limits table around `scheduled_jobs`) was not
  re-proofed cell by cell against `plans.ts` in this pass. A diff of that table
  against `planLimits.max` is a cheap follow-up if an operator is quoting caps
  from the doc.
- `docs/contributing/code-health-receipts.md` is explicitly dated 2026-08-30.
  Treat it as a receipt, not a live dashboard.
- [ADR 0037](../contributing/decisions/0037-no-author-packages-invoke.md) still
  points at issue #1750 for deleting the quarantined computed-import helper.
  This pass did not re-audit that soak. Finish it when the issue's criteria say
  so. Do not reopen `packages.invoke`.
- [ADR 0046](../contributing/decisions/0046-community-is-the-catalog.md) accepts
  leftover "community listing" wording in MCP copy and privacy docs until a
  dual-declare cut. Leave that wording alone.

---

## Otherwise: packaging, pricing, Discord, recent churn

**Community model is coherent.** Publish-gated composition
([0021](../contributing/decisions/0021-publish-gated-package-composition.md)),
platform packages are fork-only
([0036](../contributing/decisions/0036-platform-packages-fork-only.md)), no
author `packages.invoke` (0037), community is the catalog (0046). New packages
start private. Listings stay out of general MCP search. README and `AGENTS.md`
are required to publish a version. `community/service.ts` is large because fork,
adopt, publish, and catalog share it. That is a file-size fact, not a model bug.
F4 is the consent bug beside the model, not a reason to replace the model.

**Pricing.** The public ladder matches the code. Improved-search copy on
`/pricing` is flag-gated, so a signed-out visitor does not see a feature the
flag has off. A free user with a per-user Jev override still gets
`skipped-plan`. The registry description matches that. Honest.

**Discord / ops loop.** Guild join on social login is best-effort and skips when
bot config is unset (local, preview, tests). Roles are a product choice (see
above), not an outage path. No Discord bot hardening review was done. The
2026-09-16 audit also skipped third-party provider account hardening. Still out
of scope.

**Recent churn, so you know where the next bug will be.** From 2026-09-13
through this SHA the hot surfaces were package apps moving to real Remix, MCP
OAuth refresh-token preservation (#2328, #2340), secret providers (#2339, #2343,
#2355), and then a tight series of search/Jev patches (#2359 through #2381,
including gateway envelope unwrap, batching, paid necessity, rate ceilings, and
identity fold). OAuth refresh persistence looks healthy (non-finding above).
Secret providers are the new trust boundary and are default off; F4 is the open
question. Search is the code most likely to drift from its own comments in the
next week. The file header in `search-jev-rerank.ts` currently matches the
gates. Keep it that way when the next scoring tweak lands.
`tools/check-worker-startup-bundles.ts` has a stack of startup-budget bumps
(entry bytes up to 5,128,000 in comments). That comment stack is becoming a
changelog. The budget check itself is the control. Do not treat a comment dollar
figure or a comment byte ceiling as a metric.

**AGENTS.md** stays an index. That is the right size. Do not paste this audit
into it.

---

## Explicit non-findings

Do not re-open these without new evidence.

- No sampled cross-user read or write outside the four documented exceptions.
- Origin owns no Durable Objects. Execute smoke is not MCP execute. Both are
  documented and true.
- `secretLock` and `secretProviderLock` do not write grants.
- Background package apps, jobs, and webhooks cannot `communityForkAdopt`.
  Hosted package apps also omit admin roles. Jobs, workflows, retrievers, and
  `packages.invoke` do not. That split is F16, not a non-finding.
- Webhook rotation, HMAC-if-declared, and previous-URL retirement match
  `docs/contributing/architecture/webhooks.md`.
- Refresh tokens are preserved when a token response omits them.
- Jev cannot be called by a free or anonymous user while the plan gate and the
  default-off flag hold. Experiments opt-in does not enable it.
- Hybrid search remains the retriever. Offline and test environments do not call
  Workers AI.
- Email quotas are enforced. Execute, outbound fetch, and job-run daily consumes
  are enforced. Storage-byte reserve is enforced on writes.
- Feature flags fail closed for authenticated cache failures. The admin audience
  select bug is fixed.
- RunLog no longer spins at 1s on an empty retention pass.
- `/pricing` is generated from `planLimits`.
- Onboarding, waiting, and the second-agent gift share one contract.
- Import-boundary lint runs in CI. Client routes and node tests are inside their
  size ratchets.
- First-party CSP, package-app origin isolation, and S256-only PKCE are in
  force.
- Progressive disclosure and the 4,000-character search default are in code, not
  only in an ADR.
- Discord role policy matches its own file header. Do not "fix" gift users into
  the paid role without a product decision.
- Large Durable Objects should shrink opportunistically, not in a dedicated
  rewrite. That policy is already written down.

## What this review did not do

- No production metrics, Sentry issue triage, Cloudflare bill, or flag-value
  changes.
- No `npm audit`, no dependency upgrades.
- No full capability-by-capability RBAC matrix.
- No browser accessibility pass.
- No load test.
- No Stripe, Discord, or third-party account hardening.
- No line-by-line proof of `account/export.ts` completeness. Export redacts
  webhook URL secrets. RunLog invocation ledger is an accepted disaster-recovery
  loss in `docs/contributing/disaster-recovery.md`.
- `packages.invoke` soak (#1750) was not re-derived.

---

## Suggested sequence

Not a commitment. Order is "what unblocks the next thing."

### First slice (no product meeting)

1. Hide `runWithSecretAuthority` in a closure. Add the workers steal test (F2).
2. Cap `sqlQuery` rows so the query fails instead of the isolate (F1,
   engineering half).
3. Delete the job vector, or record cleanup debt, before the job row (F18).
4. Cap scheduled-job retries and continue the batch on a hard throw (F6).
5. Back off RepoSessionIndex when cleanup returns errors (F14).
6. Leave F3. The write-lease heal is the backstop. Do not fail a deletion
   response after the user row is gone.

### Second slice (one product call, then code)

Hold the call on three questions:

- Do background package callers keep admin roles? Recommended: no, unless the
  package is an explicit operator tool. Hosted package apps already omit roles
  (F16).
- Which capabilities are interactive-only, and do new OAuth and remote MCP
  connections stay `usage_mode = any`? Recommended starter set:
  `communityForkAdopt` (remove from sandbox `kody.*`), `secretProviderBind`,
  `secretProviderUnbind`, `communityPublish`, `packageDelete`,
  `packageShareInvite`, `webhookUrlRotate`. Leave email, storage, and fetch
  callable. Default new connections to `packages`, and leave existing `any` rows
  until the owner locks them (F4).
- Do webhooks, subscriptions, and package exports share `execute_calls_per_day`,
  or is 60–600/min plus monthly worker-day overage the bill (F8)?

In parallel, before any Jev audience wider than per-user override (F5):

- Wall-clock deadline and batch-local state.
- Record token usage from fulfilled batches on the error path.
- Write the same Analytics Engine event from in-execute search, including
  `keepPath`.
- Decide whether pools of 8 or fewer should still run Jev on a parent/export
  clash.

Also in this slice, no meeting required: move UserMeter retention off `consume`
(F10), hold the Stripe refresh input gate (F11), write the incident card (F9).

### Third slice (only if the first two landed)

- Mailbox metadata-only list.
- Lazy `isomorphic-git` on RepoSession. Re-measure startup. Do not guess.
- Reject link-local and metadata IP hosts on secret approval, or add one
  sentence to the security residuals that IPs are allowed on purpose (M2).
- Inbound mail: outermost Authentication-Results, or treat missing results as
  suspect in production, if Cloudflare is not already dropping double-fail (M3).
  Confirm with a captured header before changing accept/reject.
- Discord roles versus effective plan, only if Kent wants the guild to match
  gifts.
- Audited community unban, or a documented SQL procedure and deletion of
  `unbanCommunityUser` (F19).
- Attach `experiments_opt_in` to `jev-search-rerank` only after the F5
  measurement gaps are closed. Otherwise leave the experiments page as an unused
  audience bit.
- Do not start a Durable Object split program.
- Do not add PostHog. If a growth readout is wanted, add `first_paid_at` and a
  UTM count to the launch page that already exists (funnel appendix).

## Onboarding and growth funnel observability

Current versus recommended.

**ID:** F15. **Severity:** P2 as a decision gap, not an incident. **Product
call:** yes, on which definition of "activated" is canonical. **Next step:**
leave the vendors alone. Spike one paid stamp and one acquisition chart on the
page that already exists.

No production counts were queried. This is the code that would produce them.

### What already exists

Acquisition and activation are mostly write-once columns on `users`, not a
third-party product-analytics pipeline.

| Stage                    | Where it is recorded                                                                                                                                                                                                                                                                                           | Where an operator can see it                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Homepage → signup intent | Fathom `signup_started` from the login/signup client (`packages/worker/universal/fathom-events.ts`, `packages/worker/client/routes/login.tsx`)                                                                                                                                                                 | Fathom, not `/admin/insights`                                                                                                  |
| Account created          | Fathom `account_created` (query `accountCreated=1` after OAuth). D1 `users` row. Kit tag `signed_up::kody` (`packages/worker/src/app/kit-signup.ts`). Package topic `user.created` with attribution, source `signup` / `oauth` / `admin` (`packages/worker/src/identity/user-lifecycle-subscription-event.ts`) | Fathom for the browser event. Per-user row on `/admin/users`. `user.created` is an admin package subscription, not a warehouse |
| First touch              | Write-once `utm_*`, `first_touch_landing_path`, `first_touch_referrer` (`packages/worker/migrations/0029-users-attribution-activation.sql`, `packages/worker/universal/first-touch-attribution.ts`). Homepage CTA injects `utm_source=kody.codes` so organic is not blank                                      | Admin user detail only (`packages/worker/client/routes/admin-users-detail.tsx`). No cohort chart                               |
| Email verified           | `users.email_verified_at`                                                                                                                                                                                                                                                                                      | Both admin funnels below                                                                                                       |
| Connected an agent       | `first_mcp_connected_at` plus first `mcp_client_name` (`stampFirstMcpConnected` in `packages/worker/src/identity/activation-stamps.ts`, called from `packages/worker/src/mcp-auth.ts`)                                                                                                                         | Launch funnel                                                                                                                  |
| First search             | `first_search_at` (`packages/worker/migrations/0042-users-first-search-at.sql`). Stamped only from the public search tool (`packages/worker/src/mcp/tools/search-tool-runner.ts`)                                                                                                                              | Launch funnel and admin user detail                                                                                            |
| First execute            | `first_execute_at`, stamped from `recordUsage` on execute (`packages/worker/src/usage/record-usage.ts`)                                                                                                                                                                                                        | Launch funnel and admin user detail                                                                                            |
| First saved package      | `first_saved_package_at`, stamped on package insert (`packages/worker/src/package-registry/repo.ts`)                                                                                                                                                                                                           | Launch funnel and admin user detail                                                                                            |
| Return                   | `last_active_at`, UTC day, not a per-event clock (`launch-signals.ts` comments this)                                                                                                                                                                                                                           | Launch cards: 24h / 48h / 7d                                                                                                   |
| Paid                     | Snapshot of `users.stripe_plan` + `stripe_price_id`. MRR from the price catalog. Gift and referral Standard are a separate `overlayStandard` count, excluded from paid subscribers                                                                                                                             | Launch page plan slices, not a funnel step                                                                                     |
| Wizard                   | Derived checklist in `packages/worker/universal/onboarding-process.ts`. Dismiss time is `onboarding_checklist_dismissed_at`. No step-view event                                                                                                                                                                | The wizard itself, not insights                                                                                                |

`/admin/insights` is a real dashboard
(`packages/worker/client/routes/admin-insights.tsx`, launch section in
`admin-insights-launch.tsx`). It is two funnels, not one.

**Launch funnel** (`packages/worker/src/admin/launch-signals.ts`). One `COUNT`
over live users (`deleting_at IS NULL`): signed up, email verified, first MCP,
first search, first execute, first saved package. "Since open" restricts
`created_at` to `platformPublicOpenedDay` and is the closer thing to a cohort.
The bars divide each step by signup count. The steps are not nested: a user can
have `first_execute_at` with `first_search_at` still null, so a later bar can be
taller than an earlier one. That chart is a stock, not a conversion rate.

**Classic activation funnel** (`queryActivationBase` in
`packages/worker/src/app/admin-insights-data.ts`). Signup and verified are user
counts. "Agent connected" is `COUNT(DISTINCT user_id) FROM mcp_agent_sessions`,
not `first_mcp_connected_at`. "Package forked" is `community_forks`. "Package
run succeeded" and "package activated" come from the hourly RunLog snapshot
(`packages/worker/src/run-records/package-activation-state.ts`). The type
comment says counts are monotonically non-increasing. The queries do not enforce
that. This funnel can disagree with the launch funnel on the same day.

Also on that page, and not a signup funnel: signups by week
(`buildSignupWeeks`), `usage_rollups` by month, auth audit charts from
`audit_events` (denials and categories, not conversion), job health, entitlement
pressure, Dynamic Worker cost.

Analytics Engine datasets in `packages/worker/wrangler.jsonc` are product
telemetry: `kody_usage_events`, `kody_flag_exposures`, `kody_email_events`,
`kody_mcp_protocol_events`, `kody_package_invoke_specifier_events`,
`kody_execute_interpretable_events`, `kody_mcp_search_events`. Usage rollups are
the hourly aggregate (`packages/worker/src/usage/aggregate-rollups.ts`). Search
points omit user id (F5). None of these datasets is a signup or checkout stream.

Sentry is an error pipeline. Production pins the Sentry trace sample to 0. There
are no growth breadcrumbs. `recordUsage` emits `kody.usage.*` spans when Workers
tracing is on. That is cost tracing, not a funnel chart.

PostHog is not installed. The only PostHog string in the client is the example
MCP URL `https://mcp.posthog.com/mcp`. Do not treat a user's own PostHog
connection as Kody's analytics.

### Gaps that block a data-driven signup → paid decision

1. **No paid step in either funnel.** There is no `first_paid_at`.
   `stripe_plan_refreshed_at` is overwritten on every refresh
   (`packages/worker/src/billing/subscription-sync.ts`). You can count who is
   paid now. You cannot see conversion time, or checkout started versus checkout
   finished. `POST /account/billing/checkout.json` has no Fathom event and no
   audit stamp.
2. **Two activation definitions.** Launch stamps (search, execute, saved
   package) versus RunLog `package_activated` / fork. Pick one before arguing
   about a percentage.
3. **UTM is stored and not aggregated.** Per-user fields exist. Insights does
   not group by `utm_source`. Channel decisions still require a SQL query or
   clicking through users.
4. **`first_search_at` misses in-execute search.** Only `search-tool-runner.ts`
   stamps it. The meta `search` capability does not. Agents that search inside
   `execute` never move that column.
5. **Fathom stops at account created.** No verify, connect, search, execute,
   pricing view, or checkout event. Fine as a marketing pixel. Not a product
   funnel.
6. **`last_active_at` is a day stamp.** D1/D7 "return" is calendar-day activity,
   not session retention. The launch comment already says so. Do not read 24h
   active as a rolling 24-hour window.
7. **`docs/use/privacy.md` lists activation stamps and omits
   `first_search_at`.** The column exists. The privacy sentence is short one
   stamp.

### Recommended, in order

Do not add PostHog, Mixpanel, or a new Analytics Engine dataset for this. The
user row is the right grain for a few hundred to a few thousand accounts, and
the launch page already loads it with one query.

1. Kent names the activation step that matters (recommended: `first_execute_at`,
   because execute is the billed action; saved-package and RunLog
   `package_activated` answer a different question). Hide or label the other
   funnel so the two charts stop being quoted against each other.
2. Write `first_paid_at` once, in the same subscription sync that sets
   `stripe_plan` from free to standard/pro. Add it as the last launch bar,
   since-open only. That is the signup → paid number.
3. On the same page, `GROUP BY utm_source` (and maybe `utm_campaign`) for
   since-open signups and since-open paid. The columns are already write-once.
4. Stamp `first_search_at` from the meta search path, or say in the launch
   caption that only the public `search` tool counts.
5. Optional, and only if (2) shows a drop before Stripe: one Fathom event or one
   D1 stamp when checkout is created. Not before you know the drop is there.
6. Median hours from `email_verified_at` to `first_execute_at` and from
   `first_execute_at` to `first_paid_at`, same shape as
   `medianHoursToActivation` on the classic funnel. The timestamps are already
   on the row.

Skip Sentry for this. Skip a browser "viewed /pricing" event until the paid
stamp says you cannot tell where people stop.

## Appendix: 2026-09-16 status

| 2026-09-16 | Status on this tree                                           |
| ---------- | ------------------------------------------------------------- |
| H1         | Background gate landed. Interactive `execute` residual is F4. |
| H2         | Still open. F2.                                               |
| H3         | Still open. F1.                                               |
| M1         | Still open. F4.                                               |
| M2–M3      | Still open. Carried at the same severity.                     |
| M4–M6      | Still open. Folded into F10. Not re-measured.                 |
| M7–M11, L6 | No later a11y commits found. Not re-walked.                   |
| L1–L4      | Still open. Low exploitability while SameSite holds.          |
| L5         | Still open. F10.                                              |
| N1–N3      | Still true.                                                   |
