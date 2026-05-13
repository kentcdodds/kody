# Packages and manifests

Kody's only top-level saved primitive is the **package**.

A saved package is a repo-backed module rooted at `package.json`. The standard
package fields describe the package shape, and `package.json#kody` holds the
Kody-specific metadata.

## Source of truth

Use `package.json` as the canonical source of truth for saved package metadata.

- `name` — npm-valid scoped package name (`@scope/<leaf>`); the leaf segment
  must match `kody.id` (for example `@kentcdodds/cursor-cloud-agents` pairs with
  `kody.id: "cursor-cloud-agents"`)
- `exports` — authoritative import/export map
- `kody.id` — user-scoped Kody package id
- `kody.description` — package description for search/detail
- `kody.tags` — search tags
- `kody.dependencies` — direct static saved package dependencies imported via
  `kody:@...`
- `kody.app` — optional hosted package app config
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
- package-owned retrievers

The top-level saved identity is the package.

## Package exports

`package.json.exports` is the package's callable/importable surface.

- Cross-package imports use the full package name, for example
  `kody:@scope/my-package/export-name`.
- Static `kody:@...` imports are bundled snapshots. During checks and
  publish-time artifact rebuilds, Kody records the imported saved package's
  published commit in bundle dependency metadata. A later publish of that
  imported package does not rewrite already-published dependent bundles.
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
  a placeholder so author code can keep
  `import { codemode } from "kody:runtime"`, but published bundle artifacts must
  not persist the host runtime implementation. Execution loaders hydrate the
  deployed host runtime module into every referenced
  `.__kody_virtual__/runtime.js` path, including nested static dependency
  artifacts and package-app workers.
- Callable exports are resolved from package exports, not from a second Kody
  registry.
- Packages may also export non-callable helper modules and values for reuse.

### Dynamic current-version invocation

Package runtime contexts also expose `packages.check`, `packages.invoke`, and
`packages.invokeChecked` from `kody:runtime`:

```ts
import { packages } from 'kody:runtime'

await packages.invokeChecked({
	kodyId: 'discord-general-chat',
	exportName: './handle-discord-message-created',
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
	kodyId: 'discord-general-chat',
	exportName: './handle-discord-message-created',
	params: { event, dryRun: true },
})

if (!check.ok) throw new Error(check.message)
const result = await packages.invoke(check.invoke)
```

Continue to use static `kody:@scope/package/export` imports for library-like
dependencies where the caller should keep the dependency bundle it was published
with. Use bare `packages.invoke` only after a successful `packages.check` or
when the caller intentionally accepts direct runtime failure.

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
  recommended for domain events such as Discord message ids.
- If omitted during a parent package invocation with its own idempotency key,
  Kody derives a nested key from the parent key, parent runtime surface/name,
  call order, target, export, and params so retries do not duplicate the same
  nested dispatch.
- If omitted in contexts without a parent invocation key, Kody uses a unique key
  because replay is not implied.

Security and loop safeguards:

- Resolution is same-user only; package code cannot invoke another user's saved
  package.
- `packages.invoke` requires package runtime context, preserving package-owned
  storage and caller metadata.
- Nested dynamic package invocations are depth-limited to prevent runaway
  package-to-package loops.

For the Discord gateway/subscriber pattern, switch dispatchers from statically
importing subscriber packages to
`packages.invoke({ kodyId, exportName, params, idempotencyKey })`. Republish
subscribers independently; the gateway will observe the current published
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
	idempotencyKey: 'shade-event:2026-05-03T12:00:00.000Z:office',
	params: { eventId: 'event-123', roomId: 'office' },
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
published bundle artifact dependency metadata references the package that was
just published. `already_published` responses include the same summary when the
published commit is available. The stale count compares each dependent
artifact's captured dependency commit to the current published commit.

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
