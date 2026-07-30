# Package codemods

Kody users own **saved packages**: source in Artifacts git repos, published
through repo checks into KV bundle artifacts. A **package codemod** is a
versioned, pure, deterministic, idempotent transform over a package's
**published file tree**. Codemods migrate user package source when the
platform's package API changes — the user-package analogue of D1 schema
migrations, applied fleet-wide with audit and revert support.

User-authored package contracts live in
[`packages-and-manifests.md`](./packages-and-manifests.md). Repo-backed source
and publish paths are covered in
[`architecture/data-storage.md`](./architecture/data-storage.md).

## What codemods are and are not

**Codemods are:**

- Transforms over the **published** source snapshot (the same tree
  `runRepoChecks` validates), not live Artifacts working copies.
- **Versioned in-repo** platform code, registered once, run many times across
  users and packages.
- **Pure** — `detect` and `transform` receive an in-memory file map and return
  findings or a new file map; no I/O, no ambient request context.
- **Deterministic and idempotent** — the same input tree always yields the same
  output; running `transform` twice on the result must not change files again.
- **Conservative** — when a pattern match is ambiguous, emit a `needsManual`
  finding instead of guessing.

**Codemods are not:**

- **D1 migrations.** Platform schema changes use SQL migrations under
  `packages/worker/migrations/`. Codemods change user-owned package source in
  Artifacts/KV, scoped per saved package and per user.
- **Repo-session edits.** Codemods do not patch arbitrary git working trees;
  they operate on the published snapshot the checks pipeline already built.
- **Community listing publishes.** A successful apply republishes the owning
  user's saved package only. Pinned community listings keep serving the pinned
  commit; listing snapshots are not advanced by codemod apply or revert.

## Codemod contract

Each codemod lives at
`packages/worker/src/package-codemods/codemods/NNNN-kebab-name.ts` (for example
`0001-ambient-storage-to-package-storage.ts`) and is registered in
`packages/worker/src/package-codemods/registry.ts`.

Every codemod exports:

```ts
type PackageCodemod = {
	id: string // matches filename prefix, e.g. '0001-ambient-storage-to-package-storage'
	description: string
	detect(files: PackageFileTree): PackageCodemodFinding[]
	transform(files: PackageFileTree): PackageCodemodTransformResult
}
```

`PackageCodemodTransformResult`:

```ts
type PackageCodemodTransformResult = {
	files: PackageFileTree
	changed: boolean
	changedPaths: string[]
	needsManual: PackageCodemodFinding[]
}
```

- **`detect(files)`** — read-only scan. Returns findings (paths, messages,
  severity) without mutating the tree. Used for fleet discovery and reporting.
- **`transform(files)`** — returns a new tree plus metadata. When a hunk cannot
  be migrated confidently, leave the file unchanged and append a `needsManual`
  finding rather than applying a risky rewrite.

Implementations must stay **pure**: no `fetch`, D1, KV, secrets, or reads of the
calling user. The engine supplies the published file map; the codemod returns a
transformed map.

## Authoring guide

1. **Add the module** under
   `packages/worker/src/package-codemods/codemods/NNNN-kebab-name.ts`. Use the
   next sequential id; ids are stable compatibility contracts.
2. **Register** the export in `packages/worker/src/package-codemods/registry.ts`
   so the engine and operator surfaces can resolve it by id.
3. **Prefer mechanical rewrites** with clear before/after fixtures. Cover edge
   cases (already migrated imports, commented code, string literals that look
   like patterns but are not) with **fixture tests** beside the codemod
   (`*.node.test.ts` or `*.workers.test.ts`), using small in-memory file trees
   rather than full publish integration unless the behavior requires it.
4. **Emit `needsManual`** when:
   - multiple interpretations exist,
   - the pattern spans generated or minified output,
   - a required symbol cannot be resolved from static analysis alone, or
   - the codemod would delete user logic to satisfy the migration.

The first shipped codemod is **`0001-ambient-storage-to-package-storage`**: it
replaces deprecated ambient `storage` imports from `kody:runtime` with
`packageStorage()`.

## Engine

The engine entry point is `runPackageCodemodStep` in
`packages/worker/src/package-codemods/engine.ts`. Long fleet runs are **paged**
(cursor + limit); operators drive repeated steps until the run completes.

### Modes

| Mode      | Behavior                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`    | Run `detect` only; record findings per package.                                                                                                                                                                                                                                                                                   |
| `dry-run` | Run `transform` in memory, then run the full publish check suite (`runRepoChecks`) on **both** the original and transformed trees. Pass only when transformed checks introduce **no new failures** compared to the original. Also verifies mechanical idempotency by transforming twice and requiring an unchanged second result. |
| `apply`   | Same gates as dry-run. On success: snapshot the original published tree to KV for revert, republish via `syncArtifactSourceSnapshot` with commit message `codemod(<id>): ...`, refresh the saved-package projection, and dispatch subscription events (see below).                                                                |
| `revert`  | Republish the KV-stored pre-codemod tree from a prior apply run's ledger items.                                                                                                                                                                                                                                                   |

Per-package failures are **isolated**; one package error does not abort sibling
items in the same run step.

### Safety rails

- **`skipped_unpublished`** — packages with no published commit are skipped.
- **`skipped_drift`** — when Artifacts repo HEAD has moved **past** the
  published commit (user edited source after publish), the engine skips and
  reports drift. It never overwrites unpublished work.
- **Apply snapshots** — before mutating published state, apply persists the
  pre-codemod tree to KV keyed from the ledger so revert can restore it.
- **Check gate** — apply and dry-run both require the transformed tree to pass
  `runRepoChecks` without regressions versus the original tree.

### Item statuses

Each per-package row in a run records one of:

`detected`, `clean`, `dry_run_ok`, `dry_run_new_failures`, `needs_manual`,
`skipped_drift`, `skipped_unpublished`, `applied`, `reverted`, `failed`.

## Ledger

Every run and per-package item is stored in D1 (migration
`0111-package-codemod-ledger.sql`):

- `package_codemod_runs` — run metadata (codemod id, mode, filters, cursor,
  timestamps, aggregate counts).
- `package_codemod_run_items` — one row per package attempt (status, findings,
  commit before/after, KV revert pointer, error text).

The ledger makes runs **resumable** (page forward with cursor), **auditable**
(who migrated what, when, with which commits), and **revertible** (revert mode
reads stored pre-codemod snapshots from prior apply items). All rows are scoped
by the owning user's saved package identity; cross-user reads are a bug.

## Operator surfaces

### Admin UI

`/admin/codemods` supports fleet **scan**, **dry-run**, **apply**, and
**revert** for a selected codemod. Filters include `userIds`, `packageIds`, and
`limit` so operators can canary a subset before a full fleet apply.

### MCP — caller's own packages (`packages` domain)

Authenticated users can migrate **their own** saved packages:

- `package_codemod_list`
- `package_codemod_scan`
- `package_codemod_dry_run`
- `package_codemod_apply`
- `package_codemod_revert`

These capabilities scope to the calling user's `userId` and saved package rows.

### MCP — fleet (`admin` domain)

Admin-gated equivalents for operator fleet runs:

- `admin_package_codemod_scan`
- `admin_package_codemod_dry_run`
- `admin_package_codemod_apply`
- `admin_package_codemod_revert`

Admin capabilities require `requiredRole: 'admin'` and follow the RBAC boundary
in [Authorization](./architecture/authorization.md).

## Rollout doctrine

Platform package API changes that break existing user source follow this
sequence (formalizing existing practice):

1. **Land the platform change** with deprecation shims and warnings so old
   patterns still publish.
2. **Fleet scan** — run codemod `detect` across packages; review findings and
   `needs_manual` volume.
3. **Fleet dry-run** — review diffs and dry-run reports; fix codemod gaps before
   apply.
4. **Canary apply** — use admin filters (`userIds` / `packageIds`) for a small
   cohort; monitor checks, projections, and subscriber notifiers.
5. **Fleet apply** — page through the full population.
6. **Land enforcement** — add or tighten publish-time lint/checks so **new**
   publishes cannot use the deprecated pattern.

Skipping dry-run or canary apply risks mass check failures; skipping step 6
allows new packages to reintroduce debt.

## Revert

Apply persists the pre-codemod published tree to KV and records the pointer on
the ledger item. **Revert** mode loads that snapshot for a chosen prior apply
item and republishes it through the same `syncArtifactSourceSnapshot` path,
restoring `entity_sources.published_commit`, KV snapshots, and D1 projections to
the pre-migration state. Revert dispatches `package.codemod.reverted` to
subscribers (see [Package subscriptions](../guides/package-subscriptions.md)).

Revert does not restore Artifacts working-copy edits made after apply; packages
in `skipped_drift` were never mutated by apply.

## Subscription events

After each successful **apply** or **revert**, the host dispatches
`package.codemod.applied` or `package.codemod.reverted` to packages saved by the
**owning user** that declare the topic — the same delivery pattern as
`run.error.recorded`. Payload shape and handler guidance live in
[Package subscriptions](../guides/package-subscriptions.md).

## Related

- [Packages and manifests](./packages-and-manifests.md)
- [Adding capabilities](./adding-capabilities.md) — MCP capability registration
- [Package subscriptions](../guides/package-subscriptions.md) — event payloads
- [Data storage](./architecture/data-storage.md) — published source and KV
