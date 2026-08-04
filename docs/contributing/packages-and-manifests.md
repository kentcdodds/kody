# Packages and manifests

Repos are Kody's base persisted primitive; a **package** is a repo with the
package extension activated (runtime surfaces, publish checks — see
[ADR 0003](./decisions/0003-repos-as-base-primitive.md)).

A saved package is a repo-backed module rooted at `package.json`. The standard
package fields describe the package shape, and `package.json#kody` holds the
Kody-specific metadata.

## Source of truth

Use `package.json` as the canonical source of truth for saved package metadata.

- `name` — npm-valid scoped package name (`@scope/<leaf>`); the leaf segment
  must match `kody.id` (for example `@scope/my-package` pairs with
  `kody.id: "my-package"`)
- `exports` — authoritative import/export map
- `private` — optional; a `"private": true` package cannot be published as a
  community listing
- `kody.id` — user-scoped Kody package id
- `kody.description` — short public tagline for search/detail (max 200)
- `kody.tags` — search tags
- `kody.searchText` — optional longer search text beyond the short description
- `kody.dependencies` — direct static saved package dependencies imported via
  `kody:@...`
- `kody.secretMounts` — optional package-scoped secret mount declarations
- `kody.app` — optional hosted package app config
- `kody.services` — optional package-owned service runtimes
- `kody.subscriptions` — optional package-owned event subscriptions
- `kody.emits` — optional package-emitted event topic declarations
- `kody.webhooks` — optional inbound webhook declarations bound to package
  exports (see [`docs/use/webhooks.md`](../use/webhooks.md))
- `kody.jobs` — optional package-owned schedules
- `kody.retrievers` — optional package-owned search/context retrievers

The validation schema (`authoredPackageJsonSchema` in
`packages/worker/src/package-registry/types.ts`) is authoritative when this list
and the code disagree.

The package manifest is `package.json`.

## npm dependencies

Saved packages may declare npm runtime dependencies in
`package.json#dependencies` when the dependency is compatible with the
Cloudflare Workers runtime.

Important behavior:

- Kody resolves and bundles saved-package npm dependencies during repo checks
  and publish-time artifact rebuilds.
- Published bundle artifacts are what package exports, services, jobs,
  subscriptions, retrievers, and apps execute at runtime.
- If a package declares a dependency that the bundler cannot resolve or bundle,
  repo checks fail with the underlying bundling error instead of allowing a
  publish that will only fail later at runtime.
- Runtime execution does not invent a new dependency policy or ask callers to
  choose one. Dependency handling is part of the saved-package pipeline itself.

Contributor guidance:

- Prefer Worker-safe ESM packages.
- Declare runtime dependencies under `dependencies`, not `devDependencies`.
- When debugging dependency issues, verify both `runRepoChecks(...)` and the
  published bundle artifact rebuild path, since both must agree on what the
  saved package can execute.

## Mental model

Think in terms of:

- packages
- package exports
- package apps
- package-owned services
- package-owned jobs
- package-owned subscriptions
- package-owned webhooks
- package-owned retrievers
- package-owned webhooks
- package-owned workflows (declared in runtime code, not the manifest)

The repo is the top-level persisted source; a saved package is the identity of
the activated package extension on that repo.

## Package state model

A saved package is a repo with the package extension activated. Five concepts:

1. **Package source** — Artifacts repo + D1 `entity_sources` projection;
   manifest rooted at `package.json`.
2. **Package config** — owned by the saved package id: `package.json#kody`
   metadata, secret buckets keyed by the saved package id (`kody.secretMounts`),
   and value buckets keyed by `appId` (package surfaces set `appId` to the saved
   package id).
3. **Package storage** — StorageRunner bucket
   `storageId = buildPackageStorageId(packageId)` →
   `package:{encodeURIComponent(packageId)}`, reached via `packageStorage()`
   from every package surface (exports, subscriptions, retrievers, jobs,
   services, apps).
4. **Package coordination** — `PackageServiceInstance` Durable Objects for
   `package.json#kody.services`: lifecycle/liveness and alarms only. Durable
   data stays in package storage. No general actor abstraction. App facets
   (`{packageId}:facet:{facetName}`) and package-internal DO namespaces
   (`{packageId}:{exportName}:{name}`) are app-only StorageRunner buckets under
   the package namespace, not separate saved primitives.
5. **Package jobs** — `package.json#kody.jobs` with schedule/execution metadata
   in D1 `jobs` rows; each run binds
   `job:package-job:{packageId}:{encodeURIComponent(jobName)}` scratch storage;
   package config stays keyed by the saved package id; shared durable data uses
   `packageStorage()`.

## Package exports

`package.json.exports` is the package's callable/importable surface.

- Cross-package imports use the full package name, for example
  `kody:@scope/my-package/export-name`.
- Static `kody:@...` imports are bundled snapshots. During checks and
  publish-time artifact rebuilds, Kody records the imported saved package's
  published commit in bundle dependency metadata. Republishing the imported
  package does not rewrite already-published dependent bundles.
- Literal dynamic imports such as `await import("kody:@scope/pkg/export")` are
  unsupported (use static imports when the name is known at write time and
  `packages.invoke` otherwise). New bundles rewrite the call site to a teaching
  error and publish checks fail on the pattern. Older published bundles may
  still embed a host-resolved placeholder plus review metadata; just before
  execution, Kody resolves the target package under the caller's `userId` and
  hydrates the current published `importable-module` artifact into the dynamic
  worker module graph.
- Direct static `kody:@...` imports are a breaking manifest contract: they must
  be listed in `package.json#kody.dependencies` by package name, for example
  `"dependencies": ["@scope/my-package"]` inside the `kody` object. Repo checks
  fail when a static import is missing from the list or when the list contains a
  package that is not statically imported. Type-only imports do not count, and
  declaration files such as `.d.ts` are treated as type-only. Literal dynamic
  `import("kody:@...")` expressions are not static dependency declarations.
- Computed dynamic Kody package imports are intentionally unsupported. The
  bundler rewrites non-literal `import(...)` expressions with a guard that
  throws clearly when the runtime specifier starts with `kody:@`; do not add
  arbitrary computed package resolution until the security and review model is
  designed.
- `kody:runtime` is a reserved host-external virtual module. The bundler may add
  a placeholder so author code can keep `import { kody } from "kody:runtime"`,
  but published bundle artifacts must not persist the host runtime
  implementation. Execution loaders hydrate the deployed host runtime module
  into every referenced `.__kody_virtual__/runtime.js` path, including nested
  static dependency artifacts and package-app workers.
- `packageStorage()` identity is stamped at bundle time. Modules that originate
  from a saved package (the root source of a package build via `rootPackageId`,
  and statically imported package sources) get their `kody:runtime` import
  rewritten to a per-package virtual runtime module,
  `.__kody_virtual__/package-runtime/<hex(packageId)>.js`, which re-exports the
  shared runtime and overrides `packageStorage` with a variant that closes over
  the package's immutable id. The closure survives esbuild inlining, so
  per-module identity holds even after the graph collapses into one module.
  Hydration regenerates per-package runtime modules from the id encoded in the
  path, exactly like the shared runtime module.
- The stamp routes identity but is not the security boundary. At execution,
  `packageStorage()` bucket access is granted only from host-controlled
  provenance metadata: the run's own package context, the `packageId` entries
  recorded in the bundle's static dependency metadata, and published artifacts
  the host installs for literal dynamic package imports during hydration.
  Sandbox-supplied strings never extend the grant set, so hand-written source
  claiming an arbitrary package id is rejected (`packageId` on
  `BundleArtifactDependency`, `collectPackageStorageGrantIds` in
  `#mcp/run-kody-registry.ts`, and `createPackageStorageKodyTools` in
  `#worker/storage-runner.ts`). Cross-user access stays structurally impossible
  because storage runner names are keyed by the calling user's id.
- The author-facing storage prescription is one rule per context: saved-package
  code always uses `packageStorage()` for the package's own data; ad hoc execute
  code binds a `storageId` and uses ambient `storage`; another package's data
  goes through keyless `packages.invoke`. Package-invocation runs (exports,
  subscription handlers, retrievers) bind no ambient `storage`, so guard-less
  ambient access in those contexts fails with the structured
  `runtime_helper_unbound` hint pointing at `packageStorage()`. Job and service
  runtimes bind job-/service-scoped scratch buckets. Repo checks fail (the
  `lint` result) when package sources import ambient `storage` from
  `kody:runtime` with a value named import; type-only imports and `.d.ts` files
  are exempt. The rule runs on new session check runs, publishes, and community
  fork installs — already-published artifacts are not re-validated until one of
  those events.
- Callable exports are resolved from package exports, not from a second Kody
  registry.
- Packages may also export non-callable helper modules and values for reuse.

### Dynamic invocation (`packages.invoke`)

The agent-facing package-reuse contract is two rules:

1. **Name known when the code is written → static import**
   (`kody:@scope/package/export`). The default from execute and from other
   packages: typed by the pre-exec typechecker, publish-verified by repo checks,
   visible in the dependency graph (`kody.dependencies`, dependents tracking),
   and zero per-call platform cost. Ad hoc execute bundles per call, so static
   imports from execute always see the current published version; snapshot
   staleness only affects package-to-package static dependencies.
2. **Name is data, the call needs the target package's own runtime, or the call
   needs exactly-once → `packages.invoke`.** Package runtime contexts and
   authenticated ad hoc execute calls expose it from `kody:runtime`. It is the
   only dynamic primitive and is always contract-checked before invoking.

```ts
import { packages } from 'kody:runtime'

await packages.invoke({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event },
	idempotencyKey: event.id, // only when exactly-once is needed
})
```

The `kodyId` field is the bare `package.json#kody.id` value (for example,
`github`), not the npm-scoped `package.json.name` (for example,
`@kentcdodds/github`). Static `kody:@scope/package/export` imports use the
npm-scoped name; dynamic `packages.invoke` uses the bare Kody id (or the saved
package's immutable `packageId`).

This path deliberately does not rewrite to a static `kody:@...` import during
bundle construction. It resolves the target saved package and export at call
time through the package invocation service, using the current authenticated
user and package caller context. Package code never handles external
package-invocation bearer tokens for this flow.

Invoke has two modes, selected by `idempotencyKey` (mirroring execute's
keyless/keyed convention):

- **Keyless — lean/ephemeral.** Resolves the current published version and runs
  it in the target package's own runtime (`packageContext`, `kody.secretMounts`
  package secrets, `packageStorage()`, own isolate). No idempotency ledger row;
  run records stay on-failure-only; per-call platform overhead stays in the tens
  of milliseconds.
- **Keyed — durable/exactly-once.** Claims a ledger row, records the run
  eagerly, and replays a bounded response snapshot on retry with the same key.
  For domain events (webhook event ids) and retried dispatch. `idempotency_key`
  is an accepted alias.

The pre-invoke contract check is built in: `packages.invoke` rejects before
invoking when the package or export does not exist or params are not a JSON
object, with a message of the form
`packages.invoke contract check failed: <message>` (no bracketed code prefix).
Package exports do not publish machine-readable params schemas, so Kody cannot
validate field-level params shape beyond requiring `params` to be a JSON object.
On success it returns the target export's unwrapped result; execution-phase
failures after the check passes reject with an error whose message starts with
the underlying bracketed code, for example `[invocation_failed] ...`.

Security and loop safeguards:

- Resolution is same-user only; package code cannot invoke another user's saved
  package.
- `packages.invoke` requires either package runtime context or authenticated
  execute context. Static `kody:@...` imports remain library imports in the
  caller's runtime; use keyless `packages.invoke` when execute needs to enter a
  package runtime.
- Nested dynamic package invocations are depth-limited to prevent runaway
  package-to-package loops.

For event dispatcher/subscriber packages, dispatchers should use
`packages.invoke({ kodyId, exportName, params, idempotencyKey })` rather than
statically importing subscriber packages. Republish subscribers independently;
the dispatcher will observe the current published subscriber export on its next
dispatch without being republished.

**Unsupported helpers:** `packages.invokeChecked`, `packages.check`, and literal
dynamic `import("kody:@...")` are not available. `packages.invoke` subsumes both
helpers because checking is not optional or separate. The sandbox prelude throws
teaching errors for `check` / `invokeChecked`, the bundler rewrites literal
dynamic kody imports to a teaching error, and publish checks fail on all three
with the replacement named (`deprecated-invocation-usage.ts`, shared with the
`0002-static-first-invocation` package codemod). Hydration resolves placeholder
modules inside older published bundles so pinned snapshots continue until
dependents republish. See
[Invocation overhead guardrails](./architecture/invocation-overhead-guardrails.md)
for the performance budget that keeps the keyless path honest.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package may be opened through the
generic UI runtime and hosted under the package app route.

Treat package apps like Worker-style modules:

- package app code belongs to the package repo
- package app entry is declared by `kody.app.entry`
- durable package data uses `packageStorage()` (same
  `buildPackageStorageId(packageId)` bucket as other package surfaces)
- Durable Objects / facets are app-only realtime/coordination buckets under the
  package namespace, not the persistence mechanism and not separate saved
  primitives

## Package-owned jobs

Jobs belong to packages.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Schedule/execution metadata lives in D1 `jobs` rows (package-owned config)
- Each job run binds a job-scoped scratch bucket; shared durable data uses
  `packageStorage()`
- Package config stays keyed by the saved package id

Jobs are not their own top-level saved primitive.

## Package-owned subscriptions

Subscriptions belong to packages.

- Define them under `package.json#kody.subscriptions`
- Key the record by event topic, for example `email.message.received`
- Reference a package-local `handler` module
- Optionally include a human-readable `description`
- Optionally include topic-specific `filters`

Example:

```json
{
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail."
			}
		}
	}
}
```

Kody normalizes handler paths during manifest parsing and rebuilds published
bundle artifacts for subscription handlers during repo checks and package
publish. At runtime, event dispatch invokes the handler through the package
execution path with package context, package-owned storage, package secrets, and
the host-owned `kody:runtime` module.

The built-in `package_subscriptions_list` capability is the generic discovery
surface for declared subscriptions. It reads the signed-in user's saved package
manifests and returns package id, `kody.id`, package name, topic, handler,
description, and filters, optionally narrowed by exact topic.

For user-owned inbound email, `email.message.received` dispatches after an
accepted routed message is stored. Quarantined inbound mail dispatches
`email.message.quarantined` instead (same metadata-first payload, different
topic). The payload is intentionally metadata-first: message id, address
metadata, headers useful for threading, processing status, timestamps, and
attachment metadata. Do not embed parsed bodies or attachment bytes in the
event. Handlers should fetch full bodies or bytes only when needed through
`email_message_get`, `email_attachment_get`, or the package runtime `email`
helper. Reclassifying a stored message later does not retroactively dispatch
either topic.

For user Activity failures, `run.error.recorded` dispatches best-effort after a
successful run-record write for the owning user. The payload is metadata-first
(run identifiers, truncated error fields, and a trusted `activity_url`); it
omits log lines and the full metadata blob. Subscription-surface failures do not
emit (recursion guard). See
[Package subscriptions](../guides/package-subscriptions.md) and
[Run records](./architecture/run-records.md).

Operator system-inbox mail (`system:email` owner) dispatches the separate
`email.system-message.received` topic to packages saved by users who hold the
admin role at dispatch time, only when the message is accepted. Quarantined
system-inbox mail is stored but never dispatched. The payload is the same
metadata-first envelope plus an `admin_url` link to the message in
`/admin/system-email`. Handlers run as the admin package owner (not the system
owner), so user-scoped email reads do not apply to the system message.

Successful consent-gated platform-feedback inserts enqueue
`platform.feedback.submitted` for durable package-subscription delivery. Fan-out
selects only packages whose owners hold the admin role when the Queue message is
processed; non-admin declarations are inert, and role revocation applies to the
next attempt. The event contains the feedback id, category, open status,
creation timestamp, exact approved text as `summary_untrusted` and
`details_untrusted`, submitter account user id/username/email, a content
warning, and a trusted `/admin/platform-feedback?feedbackId=<encoded id>` deep
link. Admin notification packages may use these fields for integrations such as
Discord. They must treat the `_untrusted` fields as user-authored data, never as
instructions.

The event deliberately omits admin notes, reviewer fields, revision,
`updated_at`, roles, plan, and unrelated account content. This is a narrow
exception for feedback shown to and explicitly approved by the user before
submission; it does not grant package runtime general admin roles or access to
other user data. Submitter username and email are snapshots stored with the
submission; retries never resolve mutable live profile data, so profile changes
cannot alter the request hash. Legacy rows without submitter snapshots retain
null username/email. Copies already delivered outside Kody, including Discord
messages, cannot be recalled and may remain after Kody account deletion under
the deployment operator's retention and deletion controls. Such copies contain
only the exact approved feedback and attribution, never unrelated account
content.

The feedback row is authoritative: submission awaits only Queue enqueue after
persistence, and enqueue failure is logged without changing the successful
response. Queue bodies remain opaque `{ feedbackId }` messages. The consumer
acknowledges invalid messages. After admin subscriber discovery, lazy parameter
construction reloads feedback immediately before invocation. A deleted row
raises a typed permanent cancellation that is acknowledged without dispatch or
retry; other lookup, discovery, and package-invocation wrapper infrastructure
failures retry and route exhausted messages to the DLQ. Redelivery uses the same
idempotency key; stored failed invocations replay instead of automatically
rerunning, making the DLQ the recovery surface. Terminal handler execution
failures remain isolated from sibling subscribers, and fan-out uses bounded
concurrency.

Successful community fork and rating writes similarly enqueue
`community.activity.recorded` for admin-only package-subscription delivery. The
event contains a unique event id, public listing id/name/kody id, activity kind,
acting username, timestamp, and rating scores when applicable. It omits stable
user ids, email, rating notes, forked source/package identifiers, package
source, and unrelated account content. One-click installs appear as `fork`
because both paths share the existing `community_forks` row shape. Consumer-time
admin role checks, lazy metadata reload, retry behavior, and terminal-handler
isolation match platform-feedback dispatch.

## Package-owned workflows

Packages declare workflow entrypoints in runtime code, not in
`package.json#kody`. The shared `DynamicCallableWorkflow` hub resolves workflow
targets at runtime, so any package export is callable as a workflow without a
manifest declaration.

Runtime code calls `workflows.create(...)` with the package export plus small
parameters:

```ts
import { workflows } from 'kody:runtime'

await workflows.create({
	exportName: './workflow-run-event',
	runAt: '2026-05-03T12:00:00.000Z',
	idempotencyKey: 'sync-event:2026-05-03T12:00:00.000Z:account-123',
	params: { eventId: 'event-123', accountId: 'account-123' },
})
```

In package runtime contexts (package jobs, subscription handlers, services,
package apps), `packageId` is resolved from `packageContext`. Outside package
runtime (`execute`, ad hoc jobs), pass `packageId` explicitly. See
[Workflows](../use/workflows.md) for the full runtime reference, including the
inline `code` shape.

Kody stores workflow payloads as routing metadata (`userId`, package id,
`kody.id`, source id, workflow name, export name, idempotency key, `runAt`/plan
date, and small non-secret params). Do not place secrets, OAuth tokens, full
integration configuration, or full device action payloads in workflow params or
metadata. The package export should look up current secrets/configuration from
normal package runtime helpers when it runs.

Workflow instances dedupe per `(userId, idempotencyKey)`, so repeated planners
can safely attempt to create the same scheduled instance without duplicating it.
The hub workflow sleeps until `runAt`, then invokes the saved package export
through the same package execution path used by package invocations. Workflow
instances are not search results and are not saved as a new top-level Kody
entity.

Publishing a package with a `kody.workflows` block fails fast with:

> Invalid package.json: `kody.workflows` is not a supported field; use
> `workflows.create({ packageId, exportName })` from any runtime context.

Remove the block and call `workflows.create` from runtime code instead.

## Package-owned retrievers

Retrievers let packages return user-owned documents or facts to Kody search and
automatic context retrieval without promoting those records to durable memory.

- Define retrievers under `package.json#kody.retrievers`
- Each retriever names a package export, display name, description, and one or
  more scopes: `search`, `context`
- Package metadata is the source of truth; runtime discovery uses derived KV
  manifest and scope indexes that are rebuilt on package refresh
- Retriever exports reach the package storage bucket through `packageStorage()`
  (writable, like every packageStorage surface); keeping retrievers read-mostly
  is a convention
- Host budgets default to 3s for `search` and 1s for `context` (clamped to 5s /
  3s). Optional enrichment: a timed-out or failing retriever is skipped with a
  warning and must not fail the surrounding MCP `search` / `execute` call

Example:

```json
{
	"kody": {
		"retrievers": {
			"personal-inbox": {
				"export": "./search",
				"name": "Personal Inbox",
				"description": "Searches saved notes and snippets.",
				"scopes": ["search"],
				"timeoutMs": 3000,
				"maxResults": 5
			}
		}
	}
}
```

Retriever exports receive their first function argument with `query`, `scope`,
`memoryContext`, `limit`, and `conversationId`, and return
`{ "results": [...] }` where each result has `id`, `title`, `summary`, optional
`details`, optional `score`, optional `source`, optional `url`, and optional
`metadata`.

The runtime validates retriever output before surfacing it. A retriever may
return at most 20 results; payloads with more than 20 results are rejected.
Retriever implementations should truncate or paginate before returning.

## Repo-backed workflow

Package source is edited and published through repo-backed flows.

- prefer `repo_edit_files`, `repo_apply_patch`, and related file-level session
  capabilities for package changes
- repo sessions expose a file-level API (write/replace/delete/move, patch apply,
  status, diff, log, commit, restore), not arbitrary shell or git-command
  strings; keep agent-facing guidance aligned with the deployed capability
  schema
- prefer `repo_write_file` for whole-file replacements (single-file job sources,
  freshly generated package modules, one-line config edits) — it avoids the
  unified-diff context drift that makes `git apply` heredocs brittle
- use `package_get_git_remote` and `package_publish_external_push` when a human
  or autonomous agent should drive a normal git client directly against the
  package's Cloudflare Artifacts repo
- open repo sessions by package identity when possible
- for an existing package, treat the repo snapshot as the durable source of
  truth

## External Artifacts pushes

Saved package source repos are real Cloudflare Artifacts git repositories.
`package_get_git_remote` mints a short-lived read or write token for the
canonical source repo and returns both a plain remote URL and setup commands
that use `http.extraHeader` for secret-bearing credentials.

After a direct `git push`, `package_publish_external_push` resolves the
package's default-branch HEAD, opens a transient repo session checkout at that
commit, and uses `publishFromExternalRef` to run the same package checks before
advancing `entity_sources.published_commit`. Check failures return the failed
checks and do not mutate D1, KV snapshots, published bundle artifacts, package
projections, or vectors. Non-fast-forward external heads are refused unless the
caller passes `allow_force: true`.

When publish succeeds, `package_publish_external_push` decorates the response
with `static_dependents`, a bounded summary of direct saved packages whose
published bundle artifact dependency metadata references the published package.
`already_published` responses include the same summary when the published commit
is available. The stale count compares each dependent artifact's captured
dependency commit to the current published commit.

This summary is visibility only. Do not add automatic fanout republishing to the
publish path. Agents should inspect and republish dependent packages only when
the static snapshot semantics matter for the change. Dynamic runtime invocation
through package execution, where available, resolves the current published
target at invocation time and should not force a dependent package republish.

The scheduled reconcile job in
`packages/worker/src/jobs/reconcile-artifacts-pushes.ts` is a safety net for
pushed-but-unpublished commits. Every five minutes it scans a small batch of
stale `entity_sources` rows, compares Artifacts HEAD with `published_commit`,
and calls the same external publish path when they differ.
`entity_sources.last_external_check_at` throttles the scan. At 03:00 UTC the job
also asks each checked repo to revoke expired Artifacts tokens through
`revokeStaleArtifactsTokens`.

## Search and discovery

Search returns packages as the saved-entity unit.

Package detail should expose nested exports, nested jobs, tags, and app
presence. Search should not frame exports or jobs as separate top-level saved
entities.

Saved packages carry a user-scoped **`hidden`** flag in `saved_packages` (set
via **`package_update`** with `changes.hidden`). Ranked search excludes hidden
packages by default. The public MCP **search** tool and the **meta** domain
**search** capability both accept **`includeHiddenPackages`**. Exact package
queries recognize user-owned UUIDs, `kody.id` values, current-origin account
package URLs, and owner-matching hosted package URLs without mixing in semantic
capability results. Hidden exact query matches require the opt-in; known-id
entity lookup by UUID or `kody.id`, **`package_list`**, **`package_get`**, and
context-scope package retrievers are unaffected. Hiding is not deletion,
community delisting, or entitlement exclusion.

`package_update` is reserved for mutable package settings. Manifest-derived
metadata and projections remain canonical in `package.json` and change only
through save or publish.
