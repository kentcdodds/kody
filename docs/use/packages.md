# Packages

Kody's only top-level saved primitive is the **package**.

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

Packages are the saved-entity unit across search, execute, repo editing, and UI
hosting.

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
- `kody.dependencies` — direct saved package names imported through static
  `kody:@...` imports
- `kody.app` — optional hosted package app config
- `kody.services` — optional package-owned service runtimes
- `kody.subscriptions` — optional event-topic subscriptions with package-local
  handlers
- `kody.jobs` — optional package-owned schedules

`package.json` is the manifest.

For predictable package resolution, saved packages must use a scoped
`package.json.name`, and the leaf segment must match `kody.id`. For example,
`@scope/my-package` must use `"kody": { "id": "my-package" }`. The scope is the
account username. Changing your username on `/account` rewrites every saved
package to the new `@{username}/…` name (including same-account `kody:@` imports
and `kody.dependencies`), publishes an automatic update commit per package, and
republishes any community listing that was already pinned to that package's
latest commit. Third-party integrations and dynamic invocations that hard-code
the old `@{username}` scope still need to be updated by their owners.

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
  `kody:@scope/my-package/export-name`.
- Static `kody:@...` imports in saved package code are bundled into published
  runtime artifacts as snapshots of the imported package's published bundle.
  Republishing the imported package does not change already-published
  dependents; they keep using the bundled snapshot until they are republished.
- Literal dynamic imports such as
  `await import("kody:@scope/my-package/export")` are current-version package
  dependencies. Kody leaves them out of the saved bundle and resolves the target
  package export at runtime for the signed-in user, so the next execution sees
  the target package's current published importable artifact.
- Every direct static `kody:@...` import must be declared in
  `package.json#kody.dependencies` using the imported package name, for example
  `"dependencies": ["@scope/my-package"]` inside the `kody` object. Package
  checks fail when static imports and declarations differ. Type-only imports do
  not count, declaration files such as `.d.ts` are treated as type-only, and
  current-version literal dynamic `import("kody:@...")` expressions do not need
  `kody.dependencies` declarations.
- Computed dynamic Kody package imports, including template strings and
  variables such as `import(packageSpecifier)`, are unsupported. Use a string
  literal `import("kody:@scope/my-package/export")` when you want
  current-version runtime resolution.
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

Package runtime code can invoke another package owned by the same user without
statically importing it:

```ts
import { packages } from 'kody:runtime'

const result = await packages.invoke({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event },
})
```

Use `packages.invokeChecked` for event subscribers, workflow dispatchers,
agents, and other runtime fan-out where the caller should pick up the target
package's current published export and wants Kody to validate the current
runtime contract before invoking it. The check resolves the target package at
runtime, so republishing `event-subscriber` changes what `event-dispatcher`
observes without republishing `event-dispatcher`.

Use static `kody:@scope/package/export` imports for library-like dependencies
where bundling a published dependency snapshot with the caller is desired.

Use `packages.check` when the caller wants to inspect the current contract
before deciding whether to invoke:

```ts
import { packages } from 'kody:runtime'

const check = await packages.check({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event, dryRun: true },
})

if (!check.ok) throw new Error(check.message)
console.log(check.contract)

const result = await packages.invoke(check.invoke)
```

For the common check-then-invoke flow, use the combined helper:

```ts
import { packages } from 'kody:runtime'

const result = await packages.invokeChecked({
	kodyId: 'event-subscriber',
	exportName: './handle-event',
	params: { event, dryRun: true },
})
```

Use bare `packages.invoke` only when the caller has already checked the contract
or intentionally accepts direct runtime failure. Use static
`kody:@scope/package/export` imports for library-like dependencies where
bundling the published dependency snapshot with the caller is desired.

`packages.check` returns `ok: false` with `message` and `problems` when the
package, export, or params are invalid. On success it returns `contract`
metadata, including package id/kody id/name, source id, published commit,
normalized export name, runtime target, available JSDoc/type definition, and
warnings on `check.contract.warnings`. Those warnings are important: Kody
surfaces JSDoc/type metadata but not a machine-readable params schema for
package exports, so params are only validated as a JSON object.

`packages.invoke` and `packages.invokeChecked` return the target export's
unwrapped return value. If execution fails, the promise rejects with an error
that includes the package invocation error code in the message. If the
pre-invoke check fails, `packages.invokeChecked` rejects before invoking the
target export.

The primary identifier is `kodyId`; `kody_id`, `packageId`, and `package_id` are
accepted aliases for compatibility. `exportName` is required, and `export_name`
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
library/snapshot imports in the execute caller's runtime, where
`packageStorage()` reaches the declaring package's own storage bucket (see
[Package storage](#package-storage)). Use `packages.invokeChecked` from execute
when you need to enter a saved package as that package so it receives
`packageContext`, package-owned storage, package secrets, and its own `packages`
helper.

If `idempotencyKey` is omitted, Kody generates one. In package invocations that
already have a parent idempotency key, the generated key is deterministic for
the parent key, parent runtime surface/name, call order, target, export, and
params. In contexts without a parent invocation key, Kody uses a unique key,
which avoids accidental replay. Pass your own `idempotencyKey` when the target
operation must dedupe against a domain event id.

For an event-dispatch package, subscriber dispatch should prefer the dynamic
shape above over static imports such as
`kody:@scope/event-subscriber/handle-event`, using the source event id as the
explicit `idempotencyKey` when available.

## Package storage

Every saved package owns one durable storage bucket per user, keyed by the
package's immutable id. One rule per context:

- **Writing a saved package?** Use `packageStorage()` from `kody:runtime` for
  the package's own data — always.
- **Writing ad hoc `execute` code against a caller-owned bucket?** Bind a
  `storageId` on the execute call and use ambient `storage`.
- **Touching another package's data?** Call that package's exports via
  `packages.invokeChecked({ kodyId, exportName, params })` so its own runtime
  does the reading and writing.

`packageStorage()` returns the same storage interface as ambient `storage`
(`get`/`set`/`list`/`sql`/`delete`/`clear`/`id`), writable, always bound to the
declaring package's own bucket no matter where the code runs:

- In the package's own export/invocation runtime it is the only way to reach the
  package bucket — those runs bind no ambient `storage`.
- In package jobs and services — where ambient `storage` binds job-scoped and
  service-scoped buckets — it reaches the package's shared bucket.
- When the module is statically imported (`kody:@scope/package/export`) into an
  ad hoc `execute` call or into another package, each module reads and writes
  the bucket of the package it came from, under the calling user's account.
  Ambient `storage` cannot do this; the binding is per-run, so statically
  imported code sees the caller's bucket or `undefined`.

```ts
import { packageStorage } from 'kody:runtime'

export default async function listSkills() {
	const bucket = packageStorage()
	const result = await bucket.sql('select name from skills order by name asc')
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
  an actionable error there. Bind a `storageId` and use ambient `storage`, or
  call the owning package's export via `packages.invokeChecked`.
- Provenance grants cover directly imported packages. For data owned by a
  package that is not the running package and not statically imported by the
  bundle, use `packages.invokeChecked` so its own runtime does the reading.

### Ambient `storage` in package code (removed)

Package exports, subscription handlers, and retrievers no longer bind ambient
`storage` — the legacy pattern where invocation runs bound it to the package's
own bucket has been removed. In those contexts ambient `storage` is simply
`undefined`; guard-less access to it fails with a structured
`runtime_helper_unbound` error whose remedy points at `packageStorage()`, the
one way package code reaches its bucket (same interface, same bucket, so the
migration is a rename).

Repo checks fail when package source imports ambient `storage` from
`kody:runtime` (type-only imports and `.d.ts` files are exempt), so the pattern
cannot be reintroduced at publish time.

Ambient `storage` still exists where it is not the legacy pattern: ad hoc
`execute` code with a `storageId` bound on the call (the prescribed use), and
package job and service runtimes, which still bind job-/service-scoped scratch
buckets distinct from the package bucket for already-published code. New package
source cannot import ambient `storage` (checks fail), so new job and service
code keeps run-scoped state in the package bucket under run-scoped keys instead.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package is hosted under the package
app route.

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
- internal Durable Objects or facets are implementation details, not the public
  authoring contract

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
`email.message.received`.

For stored inbound email, the topic is `email.message.received`. Its payload is
metadata-first: handlers receive the stored message id, recipient and sender
metadata, timestamps, processing status, and attachment metadata. Fetch parsed
bodies or attachment bytes only when needed with `email_message_get`,
`email_attachment_get`, or the `email` helper from `kody:runtime`. Operator
system-inbox mail dispatches the separate `email.system-message.received` topic
to packages saved by admin users; its payload adds an `admin_url` link to the
message in the admin interface. See [Email primitives](./email-primitives.md)
for the full payload shapes.

## Package-owned jobs

Packages can own jobs, and Kody also supports schedules that are not owned by a
package.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Treat their runtime state as package-owned implementation detail

Jobs are part of the package definition.

For repo-backed jobs that are not part of a saved package, use `job_schedule`
instead. `job_schedule_once` is the one-off shortcut, `job_update` can rename a
job and adjust safe mutable fields such as schedule, timezone, enabled state,
kill-switch state, params, or ES module code with a default-exported function,
`job_delete` removes an existing scheduled job by id, and `job_run_now` can
trigger an existing scheduled job immediately for debugging or ad hoc runs.

When `job_update` receives a replacement `code` string, Kody publishes a new
commit on the job's repo-backed source, and subsequent runs execute the updated
module. That is usually the easiest way to change the source of a non-package
job, since there is no `package_get_git_remote` equivalent for non-package job
sources. For multi-file edits, open the job's `source_id` with
`repo_run_commands` instead. Job code must default export a function that
receives the job `params` as its first argument; `kody:runtime` does not export
`params`.

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
- `repo_run_commands` to edit, check, and publish repo-backed package source
  after it exists using parsed, git-only command forms rather than shell

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
change through `package_save` or `repo_run_commands`. This lane supports binary
assets, which `package_save` and repo sessions do not.

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
