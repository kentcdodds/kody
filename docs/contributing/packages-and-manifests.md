# Packages and manifests

Kody's only top-level saved primitive is the **package**.

A saved package is a repo-backed module rooted at `package.json`. The standard
package fields describe the package shape, and `package.json#kody` holds the
Kody-specific metadata.

## Source of truth

Use `package.json` as the canonical source of truth for saved package metadata.

- `name` — npm-valid scoped package name (`@scope/<leaf>`); the leaf segment
  must match `kody.id` (for example `@scope/my-package` pairs with
  `kody.id: "my-package"`)
- `exports` — authoritative import/export map
- `kody.id` — user-scoped Kody package id
- `kody.description` — short public tagline for search/detail (max 200)
- `kody.tags` — search tags
- `kody.dependencies` — direct static saved package dependencies imported via
  `kody:@...`
- `kody.app` — optional hosted package app config
- `kody.subscriptions` — optional package-owned event subscriptions
- `kody.jobs` — optional package-owned schedules
- `kody.retrievers` — optional package-owned search/context retrievers

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
- package-owned jobs
- package-owned workflows
- package-owned subscriptions
- package-owned retrievers

The top-level saved identity is the package.

## Package exports

`package.json.exports` is the package's callable/importable surface.

- Cross-package imports use the full package name, for example
  `kody:@scope/my-package/export-name`.
- Static `kody:@...` imports are bundled snapshots. During checks and
  publish-time artifact rebuilds, Kody records the imported saved package's
  published commit in bundle dependency metadata. Republishing the imported
  package does not rewrite already-published dependent bundles.
- Literal dynamic imports such as `await import("kody:@scope/pkg/export")` are
  runtime/current package dependencies. Bundle artifacts persist only a
  host-resolved placeholder plus review metadata; just before execution, Kody
  resolves the target package under the caller's `userId` and hydrates the
  current published `importable-module` artifact into the dynamic worker module
  graph.
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
- Callable exports are resolved from package exports, not from a second Kody
  registry.
- Packages may also export non-callable helper modules and values for reuse.

### Dynamic current-version invocation

Package runtime contexts and authenticated ad hoc execute calls expose
`packages.check`, `packages.invoke`, and `packages.invokeChecked` from
`kody:runtime`:

```ts
import { packages } from 'kody:runtime'

await packages.invokeChecked({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event },
})
```

This path deliberately does not rewrite to a static `kody:@...` import during
bundle construction. It resolves the target saved package and export at call
time through the package invocation service, using the current authenticated
user and package caller context. Package code never handles external
package-invocation bearer tokens for this flow.

Use dynamic invocation for runtime dispatch surfaces that must pick up the
target package's current published bundle, such as event subscribers, workflows,
and agents. Prefer `packages.invokeChecked` for new dynamic calls so Kody first
checks that the current package and export exist, params are a JSON object, and
the current contract metadata can be surfaced to the caller. Use
`packages.check` directly when a caller wants to inspect the current contract or
warnings before deciding whether to invoke:

```ts
const check = await packages.check({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event, dryRun: true },
})

if (!check.ok) throw new Error(check.message)
const result = await packages.invoke(check.invoke)
```

Use static `kody:@scope/package/export` imports for library-like dependencies
where the caller should keep the dependency bundle it was published with. Use
bare `packages.invoke` only after a successful `packages.check` or when the
caller intentionally accepts direct runtime failure.

`packages.check` returns the current package id/kody id/name, source id,
published commit, normalized export name, runtime target, and available
JSDoc/type definition. It also returns warnings when validation is weak. Package
exports do not publish machine-readable params schemas, so Kody cannot validate
field-level params shape beyond requiring `params` to be a JSON object.

`packages.invoke` returns the target export's unwrapped result. Non-2xx package
invocation responses reject with an error whose message starts with the
underlying code, for example `[package_not_found] ...` or
`[export_not_found] ...`. `packages.invokeChecked` throws before invoking when
the check fails.

Idempotency:

- Callers may pass `idempotencyKey` (or `idempotency_key`) explicitly. This is
  recommended for domain events such as webhook event ids.
- If omitted during a parent package invocation with its own idempotency key,
  Kody derives a nested key from the parent key, parent runtime surface/name,
  call order, target, export, and params so retries do not duplicate the same
  nested dispatch.
- If omitted in contexts without a parent invocation key, Kody uses a unique key
  because replay is not implied.

Security and loop safeguards:

- Resolution is same-user only; package code cannot invoke another user's saved
  package.
- `packages.invoke` requires either package runtime context or authenticated
  execute context. Static `kody:@...` imports remain library/snapshot imports;
  use `packages.invokeChecked` when execute needs to enter a package runtime.
- Nested dynamic package invocations are depth-limited to prevent runaway
  package-to-package loops.

For event dispatcher/subscriber packages, switch dispatchers from statically
importing subscriber packages to
`packages.invoke({ kodyId, exportName, params, idempotencyKey })`. Republish
subscribers independently; the dispatcher will observe the current published
subscriber export on its next dispatch without being republished.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package may be opened through the
generic UI runtime and hosted under the package app route.

Treat package apps like Worker-style modules:

- package app code belongs to the package repo
- package app entry is declared by `kody.app.entry`
- Durable Objects / facets are internal implementation details, not the public
  authoring contract

## Package-owned jobs

Jobs belong to packages.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Treat schedule/runtime state as package-owned implementation detail

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

For inbound email, `email.message.received` dispatches after a routed message is
stored. The payload is intentionally metadata-first: message id, address
metadata, headers useful for threading, processing status, timestamps, and
attachment metadata. Do not embed parsed bodies or attachment bytes in the
event. Handlers should fetch full bodies or bytes only when needed through
`email_message_get`, `email_attachment_get`, or the package runtime `email`
helper.

Operator system-inbox mail (`system:email` owner) dispatches the separate
`email.system-message.received` topic to packages saved by users who hold the
admin role at dispatch time. The payload is the same metadata-first envelope
plus an `admin_url` link to the message in `/admin/system-email`. Handlers run
as the admin package owner (not the system owner), so user-scoped email reads do
not apply to the system message.

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
cannot alter the request hash. Legacy rows created before snapshots retain null
username/email. Copies already delivered outside Kody, including Discord
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
- Retriever exports run read-only against the package storage bucket

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
				"timeoutMs": 1000,
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

- prefer `repo_run_commands` for package changes
- `repo_run_commands` accepts a newline-separated parsed git-command string, not
  arbitrary shell; keep agent-facing guidance aligned with the deployed
  capability schema
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
