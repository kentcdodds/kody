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
- package subscriptions
- package-owned jobs
- package-owned retrievers
- package-owned webhooks

Packages are the saved-entity unit across search, execute, repo editing, and UI
hosting. `/account/packages/:packageId/files` browses the published text
snapshot of a saved package.

## Package state model

A saved package is a repo with the package extension activated: repos are the
durable home, packages add runtime. Four concepts make up its state:

1. **Package source** — repo-backed code and manifest rooted at `package.json`
   (Artifacts repos plus D1 `entity_sources` projections). `package.json` is the
   source of truth.
2. **Package config** — configuration owned by the saved package id: manifest
   metadata (`package.json#kody`) and package-scoped secrets (secret buckets
   keyed by the saved package id, mounted via `kody.secretMounts`).
3. **Package storage** — the package's durable StorageRunner (SQLite) bucket,
   reached via `packageStorage()` from `kody:runtime`. This is the durable-data
   primitive for every package surface: exports/invocations, subscriptions,
   retrievers, jobs, and package apps. Non-secret knobs and runtime state live
   here.
4. **Package jobs** — scheduled execution owned by the package
   (`package.json#kody.jobs`): schedule/execution metadata lives in D1 job rows;
   each job run binds a job-scoped scratch bucket; package config stays keyed by
   the saved package id; shared durable data goes through `packageStorage()`.

When to use which:

- Durable package data → `packageStorage()`
- Credentials → package secrets; non-secret knobs → `packageStorage()`
- Scheduled work → a package job
- Per-app realtime internals → app facets (implementation detail, not the
  persistence mechanism)

## `package.json`

Use `package.json` as the source of truth.

Important fields:

- `name` — npm-valid package name
- `private` — leftover npm-style field; ignored for catalog listing. Visibility
  is a repo setting (`package_update` `changes.visibility`), default private.
- `exports` — authoritative import/export map
- `kody.id` — optional; if present must match the package name leaf (the URL
  slug). Prefer omitting it and letting the leaf be the slug.
- `kody.description` — short public tagline for search, detail, community
  listings, and share cards (~80–120 characters ideal; max 200). Prefer outcome
  phrasing (“Send transactional email via Resend”) over feature lists; put API
  surface, auth notes, and longer detail in README / Intent / `searchText` /
  export docs
- `kody.tags` — package tags
- `kody.category` — optional community browse category (`integrations`,
  `examples`, `productivity`, `apps`, or `utilities`). Community publish stores
  this on the listing; when it is omitted, Kody infers a category from
  well-known tags such as `github` or `zero-auth`, or files the listing under
  Other
- `kody.searchText` — optional longer search text beyond the short description
- `kody.dependencies` — map of direct saved package names imported through
  static `kody:@...` imports (`{ "@scope/package": "*" }`)
- `kody.secretMounts` — optional package-scoped secret mount declarations
- `kody.app` — optional hosted package app config
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
`package.json.name`. The leaf segment is the URL slug. `kody.id` is optional; if
present it must match that leaf. For example, `@scope/my-package` may omit
`kody.id` or set `"kody": { "id": "my-package" }`. The scope is the account
username. Changing your username on `/account` rewrites every saved package to
the new `@{username}/…` name (including same-account `kody:@` imports and
`kody.dependencies`), publishes an automatic update commit per package, and
republishes any community listing that was already pinned to that package's
latest commit. Third-party integrations and dynamic invocations that hard-code a
previous `@{username}` scope need updates from their owners.

### npm dependencies

Saved packages may declare runtime npm dependencies in `package.json`
`dependencies` and import them directly when they are compatible with the
Cloudflare Workers runtime.

- Kody bundles those dependencies for package exports, package apps,
  package-owned jobs, and package subscription handlers.
- Dependency resolution happens during package checks and publish-time artifact
  rebuilds, not by ad hoc package installs during normal execution.
- If a declared dependency cannot be resolved or bundled, package checks fail
  with the bundling error instead of allowing a publish that only fails later at
  runtime.
- If bundle validation exceeds the isolated check runner's memory or CPU limits,
  the usual cause is the npm graph, not the package source. Keep the package as
  a thin orchestrator and offload that work; see
  [Offload work that does not fit a Worker isolate](../guides/heavy-work-offload.md).
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
- **Platform (built-in) scopes are fork-only.** When a scope's username belongs
  to a platform account (for example `@kody`), person accounts must not
  statically import that package from ad hoc `execute` or from a saved
  person-owned package. Official `@kody` packages may still compose with each
  other. Publish checks reject `kody:@kody/…` static imports and
  `kody.dependencies` entries in person-owned package source. Execute fails the
  same way. Fork the official package into your scope (`community_fork`) and
  import that copy. Dynamic `import("kody:@kody/…")` is unsupported. Platform
  packages appear in `search` results (marked with their platform scope) so
  agents can discover them and fork.
- Static `kody:@...` imports in saved package code are bundled into published
  runtime artifacts as snapshots of the imported package's published bundle.
  Republishing the imported package does not change already-published
  dependents; they keep using the bundled snapshot until they are republished.
  Ad hoc execute code bundles per call, so static imports from execute always
  see the current published version.
- Prefer a static import when the name is known at write time. Use
  `import(specifier)` only when the package name is data. See
  [Package reuse](#package-reuse).
- Every direct static `kody:@...` import must be declared in
  `package.json#kody.dependencies` using the imported package name, for example
  `"dependencies": { "@scope/my-package": "*" }` inside the `kody` object. `*`
  means the dependency's latest published commit, captured when this package
  publishes. Package checks fail when static imports and declarations differ.
  Type-only imports do not count, and declaration files such as `.d.ts` are
  treated as type-only.
- When the target package is not known until runtime, use
  `import(packageSpecifier)` for a caller-owned or forked module.
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
- Add JSDoc to every public export. Search Purpose comes from that JSDoc;
  missing comments fall back to `Package export.` See
  [Export JSDoc](../guides/package-authoring.md#export-jsdoc) in the package
  authoring guide for the done criteria (`@param`, `@returns`, and an `@example`
  that imports `kody:@scope/id/export` and calls it). When helpful, point the
  export at a `types` file and put the JSDoc there. Package search detail and
  `package_get` surface package descriptions, export descriptions, function
  signatures, JSDoc, and type definitions.

### Package reuse

Package reuse follows two rules:

1. **Name known when the code is written → static import.** Use
   `import fn from 'kody:@scope/my-package/export-name'` from execute and from
   other packages. This is the default.
2. **Name is data → `import(specifier)`** of a caller-owned (or forked) module.
   Exactly-once work uses [workflows](./workflows.md), not a second invoke
   primitive.

```ts
import handleEvent from 'kody:@kentcdodds/event-subscriber/handle-event'
import profile from 'kody:@kentcdodds/google/profile'

const result = await handleEvent({ event })
const account = await profile({})
```

Declare every static `kody:@` import in `package.json#kody.dependencies`.
Person-owned packages must not import a platform scope; `community_fork` first.
`packageStorage()` on a static import reaches the declaring package's bucket for
**caller-owned** packages.

There is no author-facing `packages.invoke`. External trusted clients that must
call a named export over HTTP use package invocation tokens. Before sending a
user to create one, load `coding_guide_get` with
`guide: "package_invocation_token_setup"` and construct a prefilled
`/@{username}/{kodyId}?newToken=1` URL without raw token material.

Scoped resolution is exact: `kody:@kentcdodds/google` selects the caller's
package under that person scope. A person scope never grants access to another
user's packages. A platform specifier such as `kody:@kody/google` is not
runnable in a person account — `community_fork` it first.

## Package storage

Every saved package owns one durable storage bucket per user
(`storageId = package:{encodeURIComponent(packageId)}`), reached via
`packageStorage()` from `kody:runtime`. One rule per context:

- **Writing a saved package?** Use `packageStorage()` for the package's own data
  — always, including package apps, exports, subscriptions, retrievers, jobs,
  and workflows.
- **Writing ad hoc `execute` code?** Persist durable state from a saved package
  with `packageStorage()`, or statically import the owning package's export. Ad
  hoc execute has no scratch SQLite helper.
- **Touching another package's data?** Statically import that package's export
  (`import fn from 'kody:@scope/package/export'`) so its stamped
  `packageStorage()` does the reading and writing.

`packageStorage()` returns `get`/`set`/`list`/`sql`/`delete`/`clear`/`id`,
writable, always bound to the declaring package's own bucket no matter where the
code runs:

- In the package's own export/invocation runtime it is the only way to reach the
  package bucket.
- In package apps and jobs it reaches the same shared package bucket. Keep
  run-scoped state in that bucket under run-scoped keys.
- When the module is statically imported (`kody:@scope/package/export`) into an
  ad hoc `execute` call or into another package, each module reads and writes
  the bucket of the package it came from, under the calling user's account.
  Grants are per-bundle, not per-module: statically importing a package grants
  the whole bundle read/write access to that package's bucket, so treat static
  imports of unadopted community forks as a trust decision (adopt after review).

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
  an actionable error there. Statically import the owning package's export.
- Provenance grants cover directly imported packages. For data owned by a
  package that is not the running package and not statically imported by the
  bundle, import that package's export and let its stamp do the reading.

### Ambient `storage` is not a `kody:runtime` export

Repo checks fail when package source imports ambient `storage` from
`kody:runtime` (type-only imports and `.d.ts` files are exempt). Use
`packageStorage()` instead. Ad hoc execute has no scratch SQLite helper.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package is hosted under the package
app route.

Production-hosted package apps run on per-user subdomains of Kody's separate
`kody.run` domain (`https://{username}.kody.run/packages/<kody-id>/...`), not on
the signed-in app origin. Opening an app from Kody performs a short-lived
session handoff to that subdomain. Package author JavaScript cannot use the
first-party `kody_session` cookie or call authenticated Kody pages as the
signed-in user.

Package app URLs follow the mount contract: on a subdomain the public path is
`/packages/<kody-id>/<path>` (the username lives in the hostname). Kody strips
that mount before forwarding, so root-relative links such as `/audio/123` escape
the app. Build in-app links, redirects, shared links, email links, and OAuth
callbacks against `packageContext.hostedUrl` and `packageContext.appBasePath`
(derived from the serving username and `kody.id` — `/packages/<kody-id>` on a
subdomain, `/@username/packages/<kody-id>` when served inline in
non-production). See
[Package app routing](../guides/package-authoring.md#package-app-routing) for
the authoring example. Other saved-package runtime surfaces may omit these
app-specific fields.

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
  as exports and jobs
- internal Durable Objects or facets are app-only realtime/coordination details
  layered under the package namespace, not the persistence mechanism and not
  separate saved primitives

## Attached MCP servers

Enabled MCP servers from `/account/mcp-servers` are available as
`kody.mcp["name"]` in execute and in package runtimes that build caller context:
package apps (when capabilities or nested package imports need them), package
subscription handlers, package-owned jobs, workflows, HTTP invocation tokens,
and webhook delivery.

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
jobs, and apps.

Use the built-in `package_subscriptions_list` capability to discover the
signed-in user's saved package subscriptions, optionally filtered by exact
topic. This is the generic discovery step before building fan-out, debugging why
an event did or did not dispatch, or checking which packages subscribe to
`email.message.received`, `run.error.recorded`, `integration.auth.failed`,
`integration.auth.succeeded`, `mcp.server.disconnected`,
`mcp.server.reconnected`, or admin-only topics such as `status.incident.opened`,
`fleet.package_error_rate.elevated`, `fleet.entitlement.crossed`,
`auth.denial.burst`, `email.delivery.burst`, `user.created`, `user.deleted`,
`user.email_verification.failed`, `user.email_outbound.paused`, and
`email.system-message.sent`.

For accepted stored inbound email, the topic is `email.message.received`.
Quarantined inbound email dispatches `email.message.quarantined` instead. Both
payloads are metadata-first: handlers receive the stored message id, recipient
and sender metadata, timestamps, processing status, and attachment metadata.
Fetch parsed bodies or attachment bytes only when needed with
`email_message_get`, `email_attachment_get`, or the `email` helper from
`kody:runtime`. Operator system-inbox mail dispatches the separate
`email.system-message.received` topic to packages saved by admin users when the
message is accepted (quarantined system mail is stored but not dispatched); its
payload adds an `admin_url` link to the message in the admin interface.
Successful operator sends from reserved system senders dispatch
`email.system-message.sent` with the sent correspondence (recipients, subject,
and bodies) so an admin archive package can record mail that did not go through
a utility wrapper. See [Email primitives](./email-primitives.md) for the full
payload shapes.

When a run in your Activity finishes with an error, Kody dispatches
`run.error.recorded` to your packages that declare that topic. The payload is
metadata-first (run id, surface, identifiers, truncated error fields, and an
`activity_url` deep link). Fetch logs and full detail with `run_get` when
needed. See [Activity](./activity.md) and the
[package subscriptions guide](../guides/package-subscriptions.md).

When host-side OAuth token refresh fails with reconnectable caller state, Kody
dispatches `integration.auth.failed` to your packages that declare that topic.
Successful refreshes and successful `/connect/oauth` persists dispatch
`integration.auth.succeeded`. Both payloads are metadata-first (connection name,
account label, scopes, timestamps, and for failed: reason, optional provider
error fields, and trusted `reconnect_url` / `account_url`; for succeeded:
`source` and a trusted `account_url`). Every classified attempt emits; notifier
packages store working ↔ failed in package storage if they want edge-triggered
pings. See the
[package subscriptions guide](../guides/package-subscriptions.md).

When a saved MCP server leaves the ready state and stays down after a
lightweight hub retry, Kody dispatches `mcp.server.disconnected`. Recovery to
ready dispatches `mcp.server.reconnected` with the same episode id. The payload
is metadata-first (server id/name/state, `account_url`). See the
[package subscriptions guide](../guides/package-subscriptions.md).

Artifacts-backed plain repos, packages, and job sources also emit `repo.pushed`,
`repo.created`, and `repo.deleted` when Cloudflare Artifacts reports those
lifecycle events. Session workspace branch pushes (`sessions/<id>`) do not fan
out. See [Plain repos](./repos.md) and the
[package subscriptions guide](../guides/package-subscriptions.md) for payloads
and the distinction between live HEAD and package publish.

## Package webhooks

Inbound HTTP webhooks are declared under `package.json#kody.webhooks` and bound
to a package export. Declaring a webhook does not open ingress — mint a URL with
`webhook_url_mint` first. Full contract, signature examples, and payload shape:
[Inbound webhooks](./webhooks.md).

## Package-owned jobs

Recurring schedules belong on a saved package:

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Schedule and execution metadata are package-owned config (D1 job rows keyed to
  the package)
- Each job run binds a job-scoped scratch bucket
  (`job:package-job:{packageId}:{encodeURIComponent(jobName)}`); that bucket is
  run-local
- Package config (secrets and manifest mounts) stays keyed by the saved package
  id
- Shared durable data goes through `packageStorage()`

Jobs are part of the package definition. Deferred one-shot work uses
`workflows.create({ runAt })` from `execute` or package runtime — see
[Workflows](./workflows.md).

`job_update` adjusts metadata on an existing job: schedule, timezone, enabled
state, kill-switch state, params, `expires_at` (UTC ISO auto-disable; null
clears), and `preserved`. Package-owned jobs keep name and source in the package
repo — change the job entry there and publish. `job_delete` is rejected for
package-owned jobs for the same reason. `job_run_now` triggers an existing
package job immediately for debugging. When `expires_at` is reached the platform
stops scheduling and auto-disables the job; that is separate from `preserved`,
which only skips retention deletion.

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
- `package_delete` to permanently remove a saved package the owner typed the
  name of (`confirm_name` must match the package name)
- `package_update` to change mutable package settings such as hidden search
  discovery state or to lock publishes (`changes.locked: true`). Unlocking is
  website-only.
- `repo_edit_files`, `repo_apply_patch`, `repo_commit`, `repo_run_checks`, and
  `repo_publish_session` to edit, validate, and publish repo-backed package
  source through the file-level session API

### Platform maintenance migrations (codemods)

When the platform's package API changes, Kody may migrate your published package
source with a **package codemod**: a versioned, deterministic, code-reviewed
transform that ships in the open-source repository. An applied codemod runs the
normal checks, records a `codemod(<id>): ...` commit in your package's git
history, keeps a revert snapshot, and dispatches a `package.codemod.applied`
event your packages can subscribe to. Unlocked packages also advance
`published_commit`. Locked packages still receive the commit on HEAD so you can
review and promote it later; they do not skip the transform. Ambiguous matches
are never rewritten — they surface as findings for you instead. What this does
and does not expose to deployment admins is covered in
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
executable, and editable. Hiding is separate from **visibility**
(`package_update` `changes.visibility`, which lists or unlists the catalog) and
from entitlement or access grants.

## Delete a package

Deleting a package removes it from the account. It is permanent.

Use:

- The **Delete package** control on the package page (`/@username/{kodyId}`, or
  open a row from `/account/packages`). A modal asks you to type the package
  name to confirm.
- **`package_delete`** with a saved **`package_id`**. Show the owner the package
  name and what will be destroyed, wait for them to type that name, then pass
  **`confirm_name`** matching the package name exactly (`package.json` `name`,
  for example `@you/my-package`). The capability refuses the delete and names
  the expected value when `confirm_name` is missing or wrong.

Delete removes the package from discovery, stops its jobs, clears package
storage and package-scoped secrets, drops invocation tokens, and unlists a
public catalog entry if one exists. Artifact repos are cleaned up best-effort.
Existing forks keep their copies.

Hiding and making a package private are not deletion. Use those when the package
should stay saved.

**`package_list`** and **`package_get`** return a **`hidden`** boolean on each
package summary. Ranked **search** excludes hidden packages unless the caller
passes **`includeHiddenPackages: true`**. Known-id **`entity`** lookups still
resolve hidden packages.

## Publish lock

A package with a **`locked_at`** timestamp on `/account/packages` (and on
`package_list` / `package_get`) keeps serving its current published tree. Agents
and the five-minute reconcile job cannot advance `published_commit`. Use
**`package_update`** with **`changes: { locked: true }`** to lock a package.
Agents cannot unlock. If an agent needs the package unlocked, it should send the
owner to `/@{username}/{kodyId}` so they can click the lock icon.
`package_update` rejects **`changes.locked: false`** and returns that URL.

When an agent pushes or saves a locked package, the commit still lands on
Artifacts HEAD. Publish tools then return **`locked`** with an
**`approval_url`** that names that commit:
`/account/packages/:packageId/approve-publish?commit=<sha>`. Opening that URL
and clicking **Promote this commit** runs the real publish (checks, bundle
artifacts, projections) for that SHA. Promoting one commit does not unlock the
package.

Fleet package-codemod apply does the same HEAD write on locked packages: the
transform commits and pushes so you can review it the next time you publish. It
does not skip locked packages, and it does not move `published_commit`.

When a provider token is coarser than the job — Gmail has `gmail.send` but no
drafts-only scope — the lock is the real grant. Worked example:
[Gmail drafts without send](../guides/locked-gmail-drafts.md).

Publish lock does not shrink an OAuth token or an MCP connector. To keep a
connected MCP server off execute and other packages, lock the **server** to this
package instead:
[Lock an MCP server to a package](../guides/locked-mcp-server.md).

## Community fork provenance

**`package_list`** and **`package_get`** return community-fork provenance on
each package summary (`source_listing_id`, `listing_current`, `listing_kody_id`,
`listing_name`, `origin_commit`, `listing_pinned_commit`,
`listing_published_at`, `listing_ahead`). Those fields are `null` for
self-authored packages. When `listing_ahead` is true, `/account/packages`, the
listing page, package search, and `{kodyId}:package` entity detail surface a
**Fork outdated** / absorb next step. Full workflow:
[Public packages → Forking a listing](./community-packages.md#forking-a-listing).

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
   `Authorization: Bearer ...` extra header, `git_author` (the signed-in Kody
   account email and display name), and setup commands that use
   `git -c http.extraHeader=...` so the token does not need to be saved in shell
   history or `.git/config`. Those commands also set local `user.email` /
   `user.name` from `git_author`. Use that identity for commits; do not invent
   an email.

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

   Run every `setup_commands` entry from the `package_get_git_remote` result, in
   order, before creating commits. That sequence clones the repo, `cd`s into it,
   and sets local `user.email` / `user.name` from `git_author`. Then edit,
   commit, and push:

   ```bash
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
   `already_published`. If the package is locked, it returns `locked` with a
   `pending_commit` and `approval_url` after checks pass and leaves
   `published_commit` unchanged. If checks fail, it returns `checks_failed` with
   the failed check entries and leaves the underlying storage state unchanged.
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
