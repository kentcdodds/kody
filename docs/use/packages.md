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
- `kody.app` — optional hosted package app config
- `kody.jobs` — optional package-owned schedules

`package.json` is the manifest.

## Package exports

`package.json.exports` is the package's callable and importable surface.

- Cross-package imports use specifiers such as `kody:@my-package/export-name`.
- Callable exports are exports whose resolved module default export is a
  function.
- Packages may also export non-callable helper modules and values for reuse.

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

## Package-owned jobs

Packages can own jobs, and Kody also supports schedules that are not owned
by a package.

- Define them under `package.json#kody.jobs`
- Reference package-local entry modules
- Treat their runtime state as package-owned implementation detail

Jobs are part of the package definition.

For repo-backed jobs that are not part of a saved package, use
`job_schedule` instead. `job_schedule_once` remains available as the one-off
shortcut, and `job_run_now` can trigger an existing scheduled job immediately
for debugging or ad hoc runs.

## Save and edit packages

Use:

- `package_save` to create or replace a saved package
- `package_get` and `package_list` to inspect saved packages
- `repo_edit_flow` / `repo_open_session` / `repo_publish_session` to edit the
  repo-backed package source after it exists

## Search and discovery

Search returns packages as the saved-entity unit.

Package detail includes nested exports, nested jobs, tags, and app presence.
Search should not frame exports or jobs as separate top-level saved entities.
