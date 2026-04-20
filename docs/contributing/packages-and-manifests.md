# Packages and manifests

Kody's only top-level saved primitive is the **package**.

A saved package is a repo-backed module rooted at `package.json`. The standard
package fields describe the package shape, and `package.json#kody` holds the
Kody-specific metadata.

## Package state model

Package authors should think in five related but distinct concepts:

1. **Package source** — the repo-backed code and manifest rooted at
   `package.json`
2. **Package config** — readable values, secrets, and manifest fields owned by
   the package id
3. **Package storage** — durable state in `StorageRunner` addressed by a
   `storageId`
4. **Package-owned jobs** — scheduled executions declared by the package
5. **Package-owned runtime internals** — package-app backends or actor-like
   coordination units implemented behind the package surface

The important boundary is:

- `kody.id` is the stable authored package identifier in source
- the saved package id is the durable owner for package config
- `storageId` is the currently active durable state owner, which may be the
  package root or a more specific package-owned unit such as a job or internal
  actor

That means package apps and package jobs are package-owned surfaces, not
competing top-level persistence models.

## Source of truth

Use `package.json` as the canonical source of truth for saved package metadata.

- `name` — npm-valid package name
- `exports` — authoritative import/export map
- `kody.id` — user-scoped Kody package id
- `kody.description` — package description for search/detail
- `kody.tags` — search tags
- `kody.app` — optional hosted package app config
- `kody.jobs` — optional package-owned schedules

The package manifest is `package.json`.

## Mental model

Think in terms of:

- packages
- package exports
- package config
- package storage
- package-owned jobs

The top-level saved identity is the package.

## Package exports

`package.json.exports` is the package's callable/importable surface.

- Cross-package imports use specifiers such as
  `kody:@my-package/export-name`.
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
- package-root config still belongs to the saved package id
- package-root storage defaults to the saved package id
- any internal Durable Objects, facets, or actor-like namespaces are package
  implementation details layered on top of package storage, not separate saved
  primitives

## Package-owned jobs

Jobs belong to packages.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Treat schedule metadata as package-owned configuration
- Treat each job's `storageId` as job-local durable state
- Keep package-level values/secrets bound to the saved package id rather than
  to the job storage bucket

Jobs are not their own top-level saved primitive.

## Repo-backed workflow

Package source is edited and published through the repo session capabilities.

- prefer `repo_edit_flow` for common package changes
- open repo sessions by package identity when possible
- treat the repo snapshot as the durable source of truth after the package
  exists

## Search and discovery

Search returns packages as the saved-entity unit.

Package detail should expose nested exports, nested jobs, tags, and app
presence. Search should not frame exports or jobs as separate top-level saved
entities.
