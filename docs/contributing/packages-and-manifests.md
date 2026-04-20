# Packages and manifests

Kody's only top-level saved primitive is the **package**.

A saved package is a repo-backed module rooted at `package.json`. The standard
package fields describe the package shape, and `package.json#kody` holds the
Kody-specific metadata.

## Source of truth

Use `package.json` as the canonical source of truth for saved package metadata.

- `name` — npm-valid package name
- `exports` — authoritative import/export map
- `kody.id` — user-scoped Kody package id
- `kody.description` — package description for search/detail
- `kody.tags` — search tags
- `kody.app` — optional hosted package app config
- `kody.jobs` — optional package-owned schedules

There is no `kody.json`.

## Mental model

Think in terms of:

- packages
- package exports
- package apps
- package-owned jobs

There are no separate top-level saved skills, saved apps, or saved jobs in the
intended architecture.

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
- Durable Objects / facets are internal implementation details, not the public
  authoring contract

## Package-owned jobs

Jobs belong to packages.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Treat schedule/runtime state as package-owned implementation detail

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
