# Packages

Repos are Kody's durable home for versioned source; a **package** is a repo with
runtime surfaces activated (see [Repos](./repos.md)). Activation is explicit: a
root `package.json` alone does not make a plain repo a package —
`repo_promote_to_package` (or creating through the package lanes) does.

A saved package is a repo-backed module rooted at `package.json`. Standard
package fields describe the package surface, and `package.json#kody` holds the
Kody-specific metadata.

## Mental model

Think in terms of:

- packages
- package exports
- package apps
- package services
- package subscriptions
- package-owned jobs
- package-owned retrievers
- package-owned webhooks

Packages are the saved-entity unit across search, execute, repo editing, and UI
hosting.

## Package state model

A saved package is a repo with the package extension activated: repos are the
durable home, packages add runtime. Five concepts make up its state:

1. **Package source** — repo-backed code and manifest rooted at `package.json`
   (Artifacts repos plus D1 `entity_sources` projections). `package.json` is the
   source of truth.
2. **Package config** — configuration owned by the saved package id: manifest
   metadata (`package.json#kody`), package-scoped secrets (secret buckets keyed
   by the saved package id, mounted via `kody.secretMounts`), and app-scoped
   values (value buckets keyed by `appId`, which package surfaces set to the
   saved package id).
3. **Package storage** — the package's durable StorageRunner (SQLite) bucket,
   reached via `packageStorage()` from `kody:runtime`. This is the durable-data
   primitive for every package surface: exports/invocations, subscriptions,
   retrievers, jobs, services, and package apps.
4. **Package coordination** — package services (`package.json#kody.services`)
   are the package-wide named stateful coordination unit: long-lived,
   background-managed, and alarm-capable (`serviceContext.setAlarm` /
   `clearAlarm`), with lifecycle status. Durable data still lives in package
   storage; the service holds lifecycle/liveness only. There is no separate
   general actor abstraction. App facets and package-internal Durable Object
   namespaces are app-only implementation details layered on package storage,
   not separate saved primitives.
5. **Package jobs** — scheduled execution owned by the package
   (`package.json#kody.jobs`): schedule/execution metadata lives in D1 job rows;
   each job run binds a job-scoped scratch bucket; package config stays keyed by
   the saved package id; shared durable data goes through `packageStorage()`.

When to use which:

- Durable package data → `packageStorage()`
- Credentials and non-secret config → package secrets and values
- Long-lived coordination and alarms → a package service
- Scheduled work → a package job
- Per-app realtime internals → app facets (implementation detail, not the
  persistence mechanism)

## `package.json`

Use `package.json` as the source of truth.

Important fields:

- `name` — npm-valid package name
- `private` — when `true`, blocks public community publishing (like npm); new
  packages default to `"private": true` unless the user explicitly wants a
  public community listing
- `exports` — authoritative import/export map
- `kody.id` — user-scoped Kody package id
- `kody.description` — short public tagline for search, detail, community
  listings, and share cards (~80–120 characters ideal; max 200). Prefer outcome
  phrasing (“Send transactional email via Resend”) over feature lists; put API
  surface, auth notes, and longer detail in README / Intent / `searchText` /
  export docs
- `kody.tags` — package tags
- `kody.searchText` — optional longer search text beyond the short description
- `kody.dependencies` — direct saved package names imported through static
  `kody:@...` imports
- `kody.secretMounts` — optional package-scoped secret mount declarations
- `kody.app` — optional hosted package app config
- `kody.services` — optional package-owned service runtimes
- `kody.subscriptions` — optional event-topic subscriptions with package-local
  handlers
- `kody.emits` — optional package-emitted event topic declarations
- `kody.webhooks` — optional inbound webhook declarations bound to package
  exports (mint a credential URL separately; see
  [Inbound webhooks](./webhooks.md))
- `kody.jobs` — optional package-owned schedules
- `kody.retrievers` — optional package-owned search/context retrievers

`package.json` is the manifest.

For predictable package resolution, saved packages must use a scoped
`package.json.name`, and the leaf segment must match `kody.id`. For example,
`@scope/my-package` must use `"kody": { "id": "my-package" }`. The scope is the
account username. Changing your username on `/account` rewrites every saved
package to the new `@{username}/…` name (including same-account `kody:@` imports
and `kody.dependencies`), publishes an automatic update commit per package, and
republishes any community listing that was already pinned to that package's
latest commit. Third-party integrations and dynamic invocations that hard-code a
previous `@{username}` scope need updates from their owners.

### npm dependencies

Saved packages may declare runtime npm dependencies in `package.json`
`dependencies` and import them directly when they are compatible with the
Cloudflare Workers runtime.

- Kody bundles those dependencies for package exports, package apps, package
  services, package-owned jobs, and package subscription handlers.
- Dependency resolution happens during package checks and publish-time artifact
  rebuilds, not by ad hoc package installs during normal execution.
- If a declared dependency cannot be resolved or bundled, package checks fail
  with the bundling error instead of allowing a publish that only fails later at
  runtime.
- After changing `dependencies`, republish the package so Kody can rebuild the
  published runtime bundle artifacts that execution paths use.

Do not rely on `devDependencies` for saved package runtime code. Only
`dependencies` are treated as part of the runtime package surface.

See Cloudflare's
[Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
for runtime details. Useful starting points include `p-retry`, `mailparser`,
`remark` / `mdast-util-to-markdown`, and `googleapis`; this list is not
exhaustive.

## Package exports

`package.json.exports` is the package's callable and importable surface.

- Cross-package imports use the full package name such as
  `kody:@scope/my-package/export-name`. Static import is **the default for
  package reuse** — from execute and from other packages — whenever the target
  package's name is known when the code is written. Static imports are typed,
  publish-verified, dependency-graph-visible, and add zero per-call platform
  cost.
- Static `kody:@...` imports in saved package code are bundled into published
  runtime artifacts as snapshots of the imported package's published bundle.
  Republishing the imported package does not change already-published
  dependents; they keep using the bundled snapshot until they are republished.
  Ad hoc execute code bundles per call, so static imports from execute always
  see the current published version.
- Literal dynamic imports such as
  `await import("kody:@scope/my-package/export")` are unsupported. The call site
  throws a teaching error naming the replacement, and package publish checks
  fail on them: use a static import when the name is known at write time, or
  `packages.invoke` when it is not (see
  [Dynamic package invocation](#dynamic-package-invocation)).
- Every direct static `kody:@...` import must be declared in
  `package.json#kody.dependencies` using the imported package name, for example
  `"dependencies": ["@scope/my-package"]` inside the `kody` object. Package
  checks fail when static imports and declarations differ. Type-only imports do
  not count, and declaration files such as `.d.ts` are treated as type-only.
- Computed dynamic Kody package imports, including template strings and
  variables such as `import(packageSpecifier)`, are unsupported. When the target
  package is not known until runtime, use `packages.invoke` instead.
- `kody:runtime` is always host-owned and request-scoped. Static imports such as
  `import { kody } from "kody:runtime"` stay valid, but saved package artifacts
  do not persist Kody's runtime implementation; execution always uses the
  deployed host runtime.
- Exports are normal modules. They may expose a default export, named exports,
  or both.
- Direct package invocation calls the resolved module's default export when that
  export is a function. Importing a package from `execute` or another package
  can use any named exports that the module provides.
- Packages may also export non-callable helper modules and values for reuse.
- Add JSDoc to exported functions and, when helpful, point the export at a
  `types` file. Package search detail surfaces package descriptions, export
  descriptions, function signatures, JSDoc, and type definitions.

### Dynamic package invocation

Package reuse follows two rules:

1. **Name known when the code is written → static import.** Use
   `import fn from 'kody:@scope/my-package/export-name'` from execute and from
   other packages. This is the default.
2. **Name is data, the call needs the target package's own runtime, or you need
   exactly-once → `packages.invoke`.** It is the only dynamic primitive, and it
   is always contract-checked before invoking — checking is not optional and not
   a separate API.

`packages.invoke` takes the bare `package.json#kody.id` value as `kodyId` (for
example, `github`). Do not pass the npm-scoped `package.json.name` (for example,
`@kentcdodds/github`). The scoped name belongs in static
`kody:@scope/package/export` imports instead.

```ts
import { packages } from 'kody:runtime'

const result = await packages.invoke({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event },
})
```

The optional `idempotencyKey` selects between the two invoke modes:

- **Keyless (default) — lean and ephemeral.** The call resolves the target
  package's current published version and runs it in the target package's own
  runtime: `packageContext`, `kody.secretMounts` package secrets,
  `packageStorage()`, its own isolate. No idempotency ledger row is written and
  run records stay on-failure-only, so keyless invoke stays cheap — platform
  overhead is tens of milliseconds.
- **Keyed — durable and exactly-once.** Passing `idempotencyKey` claims a ledger
  row, records the run eagerly, and replays a bounded response snapshot when the
  same key is retried. Use a key only when the call must dedupe: domain events
  (for example webhook event ids) and retried dispatch.

This mirrors execute's keyless/keyed convention: keyless is on-failure-only and
lean, keyed is durable and replayable.

Because invocation resolves the target package at runtime, republishing
`event-subscriber` changes what a dispatcher observes without republishing the
dispatcher. For an event-dispatch package, subscriber dispatch should use
`packages.invoke` with the source event id as the explicit `idempotencyKey` when
available.

`packages.invoke` returns the target export's unwrapped return value. If the
pre-invoke contract check fails (missing package, missing export, params not a
JSON object), the promise rejects before invoking the target export. If
execution fails, the promise rejects with an error that includes the package
invocation error code in the message. Kody surfaces JSDoc/type metadata but not
a machine-readable params schema for package exports, so params are only
validated as a JSON object.

The primary identifier is the bare `kodyId`; `kody_id`, `packageId`, and
`package_id` are accepted aliases. `exportName` is required, and `export_name`
is accepted as an alias.

Package runtime contexts and authenticated ad hoc MCP `execute` calls can call
`packages.invoke`, and resolution is scoped to packages owned by the current
authenticated user. Package code does not need to mint or pass
package-invocation bearer tokens. Nested package invocations are depth-limited
to prevent runaway loops.

External trusted clients that must call package exports over HTTP use package
invocation tokens instead. Before sending a user to create one, agents should
load `coding_guide_get` with `guide: "package_invocation_token_setup"` and
construct a prefilled `/account/package-invocation-tokens/new` URL without raw
token material.

Static package imports from ad hoc MCP `execute` code, such as
`kody:@scope/package/export`, do not get a package runtime context. They run as
library imports in the execute caller's runtime, where `packageStorage()` still
reaches the declaring package's own storage bucket (see
[Package storage](#package-storage)), and `{{secret:...}}` placeholders for
user-scope secrets still resolve at the fetch gateway under the calling user —
so secret-backed packages such as `github` work fully via plain static import.
Use keyless `packages.invoke` from execute when you need to enter a saved
package as that package so it receives `packageContext`, package-owned storage,
package-mounted secrets (`kody.secretMounts`), and its own `packages` helper.

**Unsupported helpers:** `packages.invokeChecked`, `packages.check`, and literal
dynamic `import("kody:@...")` are not available. Calling any of them from new
source or newly built bundles throws a teaching error naming the replacement,
and package publish checks fail on them. Older published bundles that still
embed host-resolved dynamic-import placeholders hydrate at execution time until
those packages republish. `packages.invoke` performs the contract check inline,
and the static/dynamic rules above cover the literal dynamic import cases. The
`0002-static-first-invocation` package codemod migrates `invokeChecked` call
sites mechanically.

## Package storage

Every saved package owns one durable storage bucket per user
(`storageId = package:{encodeURIComponent(packageId)}`), reached via
`packageStorage()` from `kody:runtime`. One rule per context:

- **Writing a saved package?** Use `packageStorage()` for the package's own data
  — always, including package apps, exports, subscriptions, retrievers, jobs,
  and services.
- **Writing ad hoc `execute` code against a caller-owned bucket?** Bind a
  `storageId` on the execute call and use ambient `storage`.
- **Touching another package's data?** Call that package's exports via keyless
  `packages.invoke({ kodyId, exportName, params })` so its own runtime does the
  reading and writing.

`packageStorage()` returns the same storage interface as ambient `storage`
(`get`/`set`/`list`/`sql`/`delete`/`clear`/`id`), writable, always bound to the
declaring package's own bucket no matter where the code runs:

- In the package's own export/invocation runtime it is the only way to reach the
  package bucket — those runs bind no ambient `storage`.
- In package apps, jobs, and services it reaches the same shared package bucket.
  Jobs and services may also bind separate run-scoped scratch buckets on ambient
  `storage`; use `packageStorage()` for shared durable data.
- When the module is statically imported (`kody:@scope/package/export`) into an
  ad hoc `execute` call or into another package, each module reads and writes
  the bucket of the package it came from, under the calling user's account.
  Ambient `storage` cannot do this; the binding is per-run, so statically
  imported code sees the caller's bucket or `undefined`. Note that grants are
  per-bundle, not per-module: statically importing a package grants the whole
  bundle read/write access to that package's bucket, so treat static imports of
  unadopted community forks as a trust decision (adopt after review) and use
  keyless `packages.invoke` when you want the other package's own runtime to
  mediate access.

```ts
import { packageStorage } from 'kody:runtime'

export default async function listItems() {
	const bucket = packageStorage()
	const result = await bucket.sql('select name from items order by name asc')
	return result.rows.map((row) => row.name)
}
```

`packageStorage()` identity comes from the bundler, not from source code: the
publish pipeline stamps each module with the saved package it originated from,
and execution grants bucket access only from that recorded provenance — the
running package itself and the packages the bundle statically imported.
Hand-written code cannot claim another package's id to read its bucket. Two
consequences:

- Inline `execute` code has no package provenance, so `packageStorage()` throws
  an actionable error there. Bind a `storageId` and use ambient `storage`,
  statically import the owning package's export, or call it via keyless
  `packages.invoke`.
- Provenance grants cover directly imported packages. For data owned by a
  package that is not the running package and not statically imported by the
  bundle, use keyless `packages.invoke` so its own runtime does the reading.

### Ambient `storage` in package code

Saved-package runtimes, including apps, exports, subscription handlers, and
retrievers, do not bind ambient `storage`. In those contexts ambient `storage`
is `undefined`; guard-less access fails with a structured
`runtime_helper_unbound` error whose remedy points at `packageStorage()`, the
one way package code reaches its bucket (same interface, same bucket).

Repo checks fail when package source imports ambient `storage` from
`kody:runtime` (type-only imports and `.d.ts` files are exempt).

Ambient `storage` is available for ad hoc `execute` code with a `storageId`
bound on the call, and for package job and service runtimes that bind
job-/service-scoped scratch buckets distinct from the package bucket. Because
repo checks reject ambient `storage` imports in package source, job and service
code keeps run-scoped state in the package bucket under run-scoped keys.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package is hosted under the package
app route.

Production-hosted package apps run on Kody's separate `kodyapps.dev` origin, not
on the signed-in app origin. Opening an app from Kody performs a short-lived
session handoff to that origin. Package author JavaScript cannot use the
first-party `kody_session` cookie or call authenticated Kody pages as the
signed-in user.

Use the package app model when the package needs:

- interactive UI
- browser-side forms
- hosted callback URLs
- package-owned backend behavior

When a package app depends on OAuth, saved secrets, or a third-party API, run
the integration bootstrap first: use `search` for the saved integration or
secret reference, load `coding_guide_get` with `guide: "integration_bootstrap"`,
and complete a minimal authenticated `execute` smoke test before treating the
app as ready.

Treat package apps like Worker-style modules:

- app code lives in the package repo
- the entry module is declared by `kody.app.entry`
- durable package data uses `packageStorage()` — the same shared package bucket
  as exports, jobs, and services
- internal Durable Objects or facets are app-only realtime/coordination details
  layered under the package namespace, not the persistence mechanism and not
  separate saved primitives

## Package services

A package service is optional.

When `package.json#kody.services` is present, the package can declare one or
more named service entrypoints that Kody runs with package caller context and
`packageStorage()` for the package's shared bucket.

Use the package service model when the package needs:

- long-lived or repeated background work
- package-owned daemon-like logic
- package state that is separate from browser sessions
- a service that should publish updates into a package app

Treat package services like package-owned runtime modules:

- service code lives in the package repo
- each service entry module is declared by `kody.services.<name>.entry`
- services may optionally declare `kody.services.<name>.timeoutMs` to raise the
  executor timeout for long-lived or connector-style runs
- service lifecycle is controlled through the `services` capability domain
- service starts return immediately and the service keeps running in the
  background until it finishes or is stopped
- service code can inspect its own lifecycle through `serviceContext` and the
  `service` helper exposed by `kody:runtime`
- services share the same saved package identity as package apps and jobs

## Package subscriptions

Package subscriptions let a saved package react to built-in Kody event topics.
Define them under `package.json#kody.subscriptions` as a record keyed by topic:

```json
{
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail.",
				"filters": {
					"inbox": "support"
				}
			}
		}
	}
}
```

Each subscription has:

- `handler` — required package-local module path for the event handler
- `description` — optional human-readable purpose surfaced in package detail and
  subscription listings
- `filters` — optional topic-specific metadata reserved for event dispatchers

Subscription handlers run as package runtime modules with the signed-in package
user, package-owned storage via `packageStorage()`, package context, secrets,
and `kody:runtime` helpers. Published bundle artifacts are rebuilt for
subscription handlers during package checks and publish, just like exports,
services, jobs, and apps.

Use the built-in `package_subscriptions_list` capability to discover the
signed-in user's saved package subscriptions, optionally filtered by exact
topic. This is the generic discovery step before building fan-out, debugging why
an event did or did not dispatch, or checking which packages subscribe to
`email.message.received` or `run.error.recorded`.

For accepted stored inbound email, the topic is `email.message.received`.
Quarantined inbound email dispatches `email.message.quarantined` instead. Both
payloads are metadata-first: handlers receive the stored message id, recipient
and sender metadata, timestamps, processing status, and attachment metadata.
Fetch parsed bodies or attachment bytes only when needed with
`email_message_get`, `email_attachment_get`, or the `email` helper from
`kody:runtime`. Operator system-inbox mail dispatches the separate
`email.system-message.received` topic to packages saved by admin users when the
message is accepted (quarantined system mail is stored but not dispatched); its
payload adds an `admin_url` link to the message in the admin interface. See
[Email primitives](./email-primitives.md) for the full payload shapes.

When a run in your Activity finishes with an error, Kody dispatches
`run.error.recorded` to your packages that declare that topic. The payload is
metadata-first (run id, surface, identifiers, truncated error fields, and an
`activity_url` deep link). Fetch logs and full detail with `run_get` when
needed. See [Activity](./activity.md) and the
[package subscriptions guide](../guides/package-subscriptions.md).

Artifacts-backed plain repos, packages, and job sources also emit `repo.pushed`,
`repo.created`, and `repo.deleted` when Cloudflare Artifacts reports those
lifecycle events. See [Plain repos](./repos.md) and the
[package subscriptions guide](../guides/package-subscriptions.md) for payloads
and the distinction between live HEAD and package publish.

## Package webhooks

Inbound HTTP webhooks are declared under `package.json#kody.webhooks` and bound
to a package export. Declaring a webhook does not open ingress — mint a URL with
`webhook_url_mint` first. Full contract, signature examples, and payload shape:
[Inbound webhooks](./webhooks.md).

## Package-owned jobs

Packages can own jobs, and Kody also supports schedules that are not owned by a
package.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Schedule and execution metadata are package-owned config (D1 job rows keyed to
  the package)
- Each job run binds a job-scoped scratch bucket
  (`job:package-job:{packageId}:{encodeURIComponent(jobName)}`); that bucket is
  run-local
- Package config (secrets, values, manifest mounts) stays keyed by the saved
  package id
- Shared durable data goes through `packageStorage()`

Jobs are part of the package definition.

For repo-backed jobs that are not part of a saved package, use `job_schedule`
instead. `job_schedule_once` is the one-off shortcut, `job_update` can rename a
job and adjust safe mutable fields such as schedule, timezone, enabled state,
kill-switch state, params, `expires_at` (UTC ISO auto-disable; null clears), or
ES module code with a default-exported function, `job_delete` removes an
existing scheduled job by id, and `job_run_now` can trigger an existing
scheduled job immediately for debugging or ad hoc runs. When `expires_at` is
reached the platform stops scheduling and auto-disables the job; that is
separate from `preserved`, which only skips retention deletion.

When `job_update` receives a replacement `code` string, Kody publishes a new
commit on the job's repo-backed source, and subsequent runs execute the updated
module. That is usually the easiest way to change the source of a non-package
job, since there is no `package_get_git_remote` equivalent for non-package job
sources. For multi-file edits, open a session on the job's `source_id` with
`repo_open_session` first, then use `repo_edit_files`, `repo_apply_patch`, and
related file-level session capabilities against that `session_id`. Job code must
default export a function that receives the job `params` as its first argument;
`kody:runtime` does not export `params`.

## Save and edit packages

When creating a package or materially changing an existing one, include or
maintain a root `README.md` with a concise `## Intent` section. Use it to
capture the user's goal, ask the user if the intent is unclear, and update it
only when you are confident the goal changed or the user expands the scope. This
is guidance, not a new Kody primitive or manifest field.

Use:

- `package_get_git_remote` and `package_publish_external_push` when you have a
  normal git client: mint a remote (pass `create: true` with a new `kody_id` to
  register a stub package first), clone, edit, push, and then ask Kody to
  reconcile the pushed Artifacts HEAD
- `package_save` to create or replace a saved package from a complete UTF-8 text
  file set when no local git client is available
- `package_get` and `package_list` to inspect saved packages
- `package_update` to change mutable package settings such as hidden search
  discovery state
- `repo_edit_files`, `repo_apply_patch`, `repo_commit`, `repo_run_checks`, and
  `repo_publish_session` to edit, validate, and publish repo-backed package
  source through the file-level session API

### Platform maintenance migrations (codemods)

When the platform's package API changes, Kody may migrate your published package
source with a **package codemod**: a versioned, deterministic, code-reviewed
transform that ships in the open-source repository. An applied codemod
republishes through the normal checks, records a `codemod(<id>): ...` commit in
your package's git history, keeps a revert snapshot, and dispatches a
`package.codemod.applied` event your packages can subscribe to. Ambiguous
matches are never rewritten — they surface as findings for you instead. What
this does and does not expose to deployment admins is covered in
[Privacy → Platform maintenance](./privacy.md#platform-maintenance-package-codemods).

## Hidden packages

Use **`package_update`** with a saved **`package_id`** and
**`changes: { hidden: true }`** to hide a package from ordinary ranked search.
Set **`hidden: false`** inside `changes` to show it again. The result includes
the persisted package summary so callers can verify the new state.

`package_update` only accepts mutable settings. Canonical metadata including
name, description, tags, `kody.id`, app presence, and source projection remains
derived from `package.json` and changes through save or publish.

Hiding is a discovery preference, not deletion. The package stays saved,
executable, and editable. Hiding is separate from **`package.json#private`**
(community publishing) and from entitlement or access grants.

**`package_list`** and **`package_get`** return a **`hidden`** boolean on each
package summary. Ranked **search** excludes hidden packages unless the caller
passes **`includeHiddenPackages: true`**. Known-id **`entity`** lookups still
resolve hidden packages.

## Author a saved package via direct git push

Saved package source is backed by a Cloudflare Artifacts git repository. You can
create and edit it with a normal git client without round-tripping each file
change through `package_save` or the file-level repo session capabilities
(`repo_edit_files`, etc.). This lane supports binary assets, which
`package_save` and repo sessions do not.

Individual files may be at most 10 MiB (10,485,760 bytes), measured as the
file's stored byte length — UTF-8 bytes for text files, raw bytes for binary
assets. Publish checks reject any file over that per-file limit (and any source
root over the aggregate publish caps) with guidance to host the file on storage
you manage — for example Cloudflare R2, Amazon S3, Dropbox, or Google Drive —
and commit a small link or pointer file instead. Kody never rewrites your files
into pointers for you. The Artifacts remote itself also fails pushes above
roughly 32 MiB of pack content with a raw HTTP 413 before Kody is involved, so
oversized files can fail at `git push` with an unhelpful error even before
publish checks run.

1. Mint a short-lived remote credential:

   ```json
   {
   	"package_id": "pkg_123",
   	"scope": "write",
   	"ttl_seconds": 1800
   }
   ```

   Call `package_get_git_remote` with either `package_id` or `kody_id`. The
   result includes the plain remote URL, an authenticated one-line clone URL, an
   `Authorization: Bearer ...` extra header, and setup commands that use
   `git -c http.extraHeader=...` so the token does not need to be saved in shell
   history or `.git/config`.

   To start a **new** package in this lane, pass `create: true` with the new
   `kody_id` (and an optional `description`):

   ```json
   {
   	"kody_id": "my-package",
   	"create": true,
   	"description": "What this package is for"
   }
   ```

   Kody registers a private stub saved package (minimal `package.json`,
   `README.md` with an Intent placeholder, and a stub root export) and returns
   the minted remote in the same call. Replace the stub content in your first
   push.

2. Clone and edit:

   ```bash
   git -c http.extraHeader='Authorization: Bearer art_v1_...' clone \
   	https://<account>.artifacts.cloudflare.net/git/default/<repo>.git \
   	my-package
   cd my-package
   # edit files
   git add .
   git commit -m "fix: update package behavior"
   git -c http.extraHeader='Authorization: Bearer art_v1_...' push origin HEAD:<defaultBranch>
   ```

   Use the default branch returned by `package_get_git_remote` for
   `<defaultBranch>`.

3. Publish the pushed Artifacts HEAD:

   ```json
   {
   	"package_id": "pkg_123"
   }
   ```

   Call `package_publish_external_push`. Kody checks the pushed tree server-side
   before recording the new published version, writing the published source
   snapshot, rebuilding package bundle artifacts, and refreshing search
   projections. If the pushed HEAD is already current, the tool returns
   `already_published`. If checks fail, it returns `checks_failed` with the
   failed check entries and leaves the underlying storage state unchanged.
   Successful `published` responses, and `already_published` responses when the
   metadata is available, include a bounded `static_dependents` summary of
   direct saved packages whose published bundle artifacts statically reference
   this package. Stale entries mean the dependent bundle captured a dependency
   commit that differs from the current published commit. Kody does not
   automatically republish those dependents; inspect and republish only the ones
   whose static snapshot should reference the current published commit.

Dynamic package invocation is different from static bundled imports. When a
runtime feature invokes another package dynamically through the package
execution path, it resolves the current published package at invocation time
instead of embedding a source snapshot in the dependent bundle. Dynamic
invocation should not require republishing a dependent package just because the
called package was republished.

Choose the narrowest token scope that fits the task. Use `read` for inspection
or local diffing, and `write` only when the git client needs to push. Keep TTLs
short for autonomous agents and CI-style helpers; the tool accepts 60 seconds to
24 hours and defaults to 4 hours.

## Search and discovery

Search returns packages as the saved-entity unit.

Ranked package search hits may include a concise README excerpt when the saved
package has a root README so agents can learn usage, examples, and maintenance
notes without separately cloning the package repository.

Exact package detail includes nested exports, nested jobs, tags, app presence,
and README content when a root README exists. Search should not frame exports or
jobs as separate top-level saved entities.
