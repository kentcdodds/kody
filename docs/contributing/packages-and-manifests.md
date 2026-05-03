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
- `kody.app` — optional hosted package app config
- `kody.jobs` — optional package-owned schedules
- `kody.workflows` — optional package-owned durable workflow declarations
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
- Callable exports are resolved from package exports, not from a second Kody
  registry.
- Packages may also export non-callable helper modules and values for reuse.

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

Workflows belong to packages.

Use `package.json#kody.workflows` to name durable workflow entrypoints that
package code can schedule through `kody:runtime`:

```json
{
	"kody": {
		"workflows": {
			"shade-event": {
				"export": "./run-event",
				"description": "Runs one planned shade event."
			}
		}
	}
}
```

Runtime code calls `workflows.create(...)` with routing metadata and small
parameters:

```ts
import { workflows } from 'kody:runtime'

await workflows.create({
	workflowName: 'shade-event',
	exportName: './run-event',
	runAt: '2026-05-03T12:00:00.000Z',
	idempotencyKey: 'shade-event:2026-05-03T12:00:00.000Z:office',
	params: { eventId: 'event-123', roomId: 'office' },
})
```

Kody stores Cloudflare Workflow instance payloads as package-routing metadata:
`userId`, package id, `kody.id`, source id, workflow name, export name,
idempotency key, `runAt`/plan date, and small non-secret params. Do not place
secrets, OAuth tokens, full connector configuration, or full device action
payloads in workflow params or metadata. The package export should look up
current secrets/configuration from normal package runtime helpers when it runs.

Workflow instance ids are deterministic for
`(userId, packageId, workflowName, idempotencyKey)`, so repeated planners can
safely attempt to create the same instance without duplicating it. The host
workflow sleeps until `runAt`, then invokes the saved package export through the
same package execution path used by package invocations. Workflow instances are
not search results and are not saved as a new top-level Kody entity.

## Package-owned retrievers

Retrievers let packages return user-owned documents or facts to Kody search and
automatic context retrieval without promoting those records to durable memory.

- Define retrievers under `package.json#kody.retrievers`
- Each retriever names a package export, display name, description, and one or
  more scopes: `search`, `context`
- Package metadata remains the source of truth; runtime discovery uses derived
  KV manifest and scope indexes that are rebuilt on package refresh
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

Retriever exports receive `params` with `query`, `scope`, `memoryContext`,
`limit`, and `conversationId`, and return `{ "results": [...] }` where each
result has `id`, `title`, `summary`, optional `details`, optional `score`,
optional `source`, optional `url`, and optional `metadata`.

The runtime validates retriever output before surfacing it. A retriever may
return at most 20 results; payloads with more than 20 results are rejected.
Retriever implementations should truncate or paginate before returning.

## Repo-backed workflow

Package source is edited and published through the repo session capabilities.

- prefer `repo_edit_flow` for common package changes
- open repo sessions by package identity when possible
- for an existing package, treat the repo snapshot as the durable source of
  truth

## Search and discovery

Search returns packages as the saved-entity unit.

Package detail should expose nested exports, nested jobs, tags, and app
presence. Search should not frame exports or jobs as separate top-level saved
entities.
