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
- package-owned jobs

Packages are the saved-entity unit across search, execute, repo editing, and UI
hosting.

## `package.json`

Use `package.json` as the source of truth.

Important fields:

- `name` — npm-valid package name
- `exports` — authoritative import/export map
- `kody.id` — user-scoped Kody package id
- `kody.description` — package description for search/detail
- `kody.tags` — package tags
- `kody.dependencies` — direct saved package names imported through static
  `kody:@...` imports
- `kody.app` — optional hosted package app config
- `kody.services` — optional package-owned service runtimes
- `kody.jobs` — optional package-owned schedules

`package.json` is the manifest.

For predictable package resolution, saved packages must use a scoped
`package.json.name`, and the leaf segment must match `kody.id`. For example,
`@kentcdodds/cursor-cloud-agents` must use
`"kody": { "id": "cursor-cloud-agents" }`.

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
  runtime artifacts as snapshots of the imported package's then-published
  bundle. If the imported package is published again later, already-published
  dependents keep using the older bundled snapshot until they are republished.
- Every direct static `kody:@...` import must be declared in
  `package.json#kody.dependencies` using the imported package name, for example
  `"dependencies": ["@scope/my-package"]` inside the `kody` object. Package
  checks fail when static imports and declarations differ. Type-only imports do
  not count, and declaration files such as `.d.ts` are treated as type-only;
  literal dynamic `import("kody:@...")` expressions are bundled and must be
  declared.
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
	kodyId: 'discord-general-chat',
	exportName: './handle-discord-message-created',
	params: { event },
})
```

Use `packages.invoke` for event subscribers, workflow dispatchers, agents, and
other runtime fan-out where the caller should pick up the target package's
current published export. The call resolves the target package at runtime, so
republishing `discord-general-chat` changes what `discord-gateway` observes
without republishing `discord-gateway`.

Use static `kody:@scope/package/export` imports for library-like dependencies
where bundling the currently published dependency with the caller is desired.

`packages.invoke` returns the target export's unwrapped return value. If the
target package, export, or execution fails, the promise rejects with an error
that includes the package invocation error code in the message.

The primary identifier is `kodyId`; `kody_id`, `packageId`, and `package_id` are
accepted aliases for compatibility. `exportName` is required, and `export_name`
is accepted as an alias.

Only package runtime contexts can call `packages.invoke`, and resolution is
scoped to packages owned by the current authenticated user. Package code does
not need to mint or pass package-invocation bearer tokens. Nested package
invocations are depth-limited to prevent runaway loops.

If `idempotencyKey` is omitted, Kody generates one. In package invocations that
already have a parent idempotency key, the generated key is deterministic for
the parent key, parent runtime surface/name, call order, target, export, and
params. In contexts without a parent invocation key, Kody uses a unique key,
which avoids accidental replay. Pass your own `idempotencyKey` when the target
operation must dedupe against a domain event id.

For `discord-gateway`, subscriber dispatch should move from static imports such
as `kody:@kentcdodds/discord-general-chat/handle-discord-message-created` to the
dynamic shape above, using the Discord event id as the explicit `idempotencyKey`
when available.

## Package apps

A package app is optional.

When `package.json#kody.app` is present, the package can be opened through
`open_generated_ui` and hosted under the package app route.

Use the package app model when the package needs:

- interactive UI
- browser-side forms
- hosted callback URLs
- package-owned backend behavior

Treat package apps like Worker-style modules:

- app code lives in the package repo
- the entry module is declared by `kody.app.entry`
- internal Durable Objects or facets are implementation details, not the public
  authoring contract

## Package services

A package service is optional.

When `package.json#kody.services` is present, the package can declare one or
more named service entrypoints that Kody runs with package-owned storage and
package caller context.

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
commit on the job's repo-backed source and the next run uses the new module.
That is usually the easiest way to change the source of a non-package job, since
there is no `package_get_git_remote` equivalent for non-package job sources. For
multi-file edits, open the job's `source_id` with `repo_run_commands` instead.
Job code must default export a function that receives the job `params` as its
first argument; `kody:runtime` does not export `params`.

## Save and edit packages

Use:

- `package_save` to create or replace a saved package
- `package_get` and `package_list` to inspect saved packages
- `repo_run_commands` to edit, check, and publish repo-backed package source
  after it exists using parsed, git-only command forms rather than shell
- `package_get_git_remote` and `package_publish_external_push` when you want a
  normal git client to clone, edit, push, and then ask Kody to reconcile the
  pushed Artifacts HEAD

## Edit a saved package via direct git push

Saved package source is backed by a Cloudflare Artifacts git repository. You can
edit it with a normal git client without round-tripping each file change through
`package_save` or `repo_run_commands`.

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
   this package. Stale entries mean the dependent bundle captured an older
   dependency commit. Kody does not automatically republish those dependents;
   inspect and republish only the ones whose static snapshot should pick up the
   new publish.

Dynamic package invocation is different from static bundled imports. When a
runtime feature invokes another package dynamically through the package
execution path, it resolves the current published package at invocation time
instead of embedding a source snapshot in the dependent bundle. Dynamic
invocation should not require republishing a dependent package just because the
called package was republished.

Choose the narrowest token scope that fits the task. Use `read` for inspection
or local diffing, and `write` only when the git client needs to push. Keep TTLs
short for autonomous agents and CI-style helpers; the tool accepts 60 seconds to
24 hours and defaults to 30 minutes.

## Search and discovery

Search returns packages as the saved-entity unit.

Ranked package search hits may include a concise README excerpt when the saved
package has a root README so agents can learn usage, examples, and maintenance
notes without separately cloning the package repository.

Exact package detail includes nested exports, nested jobs, tags, app presence,
and README content when a root README exists. Search should not frame exports or
jobs as separate top-level saved entities.
