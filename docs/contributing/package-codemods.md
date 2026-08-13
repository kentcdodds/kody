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
- **Personal codemods.** The built-in system is for **platform-authored**
  migrations: the transform ships in this repo, reviewed and fixture-tested in
  CI, because its correctness is pinned to a platform version and it runs
  fleet-wide over other users' source. A user transforming **their own**
  packages with **their own** transform needs no primitive — every required
  power (repo sessions, `repo_run_checks` against a staged tree, gated publish,
  git history) already exists as user capabilities. That userland pattern is
  packaged as the
  [`@kentcdodds/codemod-runner`](https://kody.codes/community/b06c0f98-865a-4379-adb0-d0fb2cdda14f)
  community package: same contract vocabulary (`detect`/`transform`,
  dry-run-before-apply, drift skips, idempotency verification, revert
  snapshots), with the codemod authored as a package export the user owns. As
  with any community package, inspect the source and fork (which pins your own
  copy) before running it against your packages. Do not grow the built-in engine
  to execute user-authored transforms; the dividing line is who authored the
  transform.

## Codemod contract

Each codemod lives at
`packages/worker/src/package-codemods/codemods/NNNN-kebab-name.ts` (for example
`0001-ambient-storage-to-package-storage.ts`) and is registered in
`packages/worker/src/package-codemods/registry.ts`.

Types in `packages/worker/src/package-codemods/types.ts`:

```ts
type PackageCodemodFinding = {
	path: string | null
	message: string
}

type PackageCodemodTransformResult = {
	files: Record<string, string>
	changed: boolean
	changedPaths: Array<string>
	needsManual: Array<PackageCodemodFinding>
}

type PackageCodemod = {
	id: string
	description: string
	detect(files: Record<string, string>): Array<PackageCodemodFinding>
	transform(files: Record<string, string>): PackageCodemodTransformResult
}
```

- **`detect(files)`** — read-only scan. Returns `{ path, message }` findings
  without mutating the tree. Used for fleet discovery and reporting.
- **`transform(files)`** — returns a new tree plus metadata. When a hunk cannot
  be migrated confidently, leave the file unchanged and append a `needsManual`
  finding rather than applying a risky rewrite. **Partial transforms are
  intentional:** when `changed: true` and `needsManual` are both set, dry-run
  and apply still proceed with the partial tree (per-file conservatism with
  per-package progress). Findings are recorded on the ledger item and returned
  to the operator; the no-new-failures check gate still runs on that partial
  tree. A codemod that must be all-or-nothing should return the original tree
  with `changed: false` and only findings.

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
5. **Never put source contents in findings.** Finding `message` values must be
   fixed, codemod-authored strings; `path` identifies the file. Interpolating
   file contents, matched snippets, identifiers from user code, or manifest
   values into a finding would surface private package source to the operator
   running the fleet scan, breaking the
   [privacy policy's codemod disclosure](../use/privacy.md#platform-maintenance-package-codemods)
   ("codemods are forbidden from embedding file contents in their findings").
   Both shipped codemods use constant messages; keep it that way.

### `0001-ambient-storage-to-package-storage`

This permanent repair codemod converts ambient `storage` imports rejected by
package publish checks to `packageStorage()` **at call sites**:

- Rewrites member uses (`storage.get(...)` → `packageStorage().get(...)`) via
  AST range replacement; it does **not** insert a module-scope
  `const storage = packageStorage()` binding.
- Adjusts the `kody:runtime` import: rename `storage` → `packageStorage`, or
  drop the `storage` specifier when `packageStorage` is already imported.
- Emits `needsManual` for aliased imports, non-member uses (value-passing),
  re-exports, multiple runtime imports, binding sites, and post-rewrite
  verification failures.
- Emits `needsManual` for **parse failures** on scannable module files that
  mention `kody:runtime` and `storage`.
- **Manifest gate:** when `package.json#kody` declares any non-empty `app`,
  `services`, `jobs`, `subscriptions`, `webhooks`, or `retrievers` surface,
  every ambient-storage candidate file gets `needsManual` — ambient `storage`
  and `packageStorage()` use different bucket identities on those execution
  surfaces, so automatic rewrite risks silent data repointing.

### `0002-static-first-invocation`

This permanent repair codemod brings package source into the static-first
two-rule contract enforced at publish time (see
[`architecture/invocation-overhead-guardrails.md`](./architecture/invocation-overhead-guardrails.md)):

- Rewrites `packages.invokeChecked(...)` member calls (including
  `packages?.invokeChecked`) to `packages.invoke(...)` via AST range replacement
  — identical input shape; `packages.invoke` is always contract-checked and
  key-less calls take the lean/ephemeral path.
- Emits `needsManual` for `packages.check(...)` (its contract return value has
  no mechanical equivalent — `invoke` checks internally) and for literal dynamic
  `import("kody:@...")` (namespace semantics and `kody.dependencies` manifest
  changes need a human), naming the replacement in each finding.
- Emits `needsManual` for parse failures on scannable module files that
  reference unsupported forms, and verifies post-rewrite that no detectable
  `packages.invokeChecked` member expressions remain.
- Detection reuses the publish-check collector
  (`package-runtime/deprecated-invocation-usage.ts`), so parsed `detect`
  findings and failing publish lint results stay in lockstep. Unparseable files
  produce codemod-only `needsManual` findings because publish lint cannot
  classify them.

## Engine

The engine entry point is `runPackageCodemodStep` in
`packages/worker/src/package-codemods/engine.ts`. Long runs are **paged**: each
call processes up to `limit` packages (or revert items) and returns `nextCursor`
plus a per-step `summary` count by item status. Repeat with the same `runId` and
`nextCursor` until `nextCursor` is null.

### Step limits

| Mode                         | Default `limit` | Max `limit` |
| ---------------------------- | --------------- | ----------- |
| `scan`                       | 20              | 50          |
| `dry-run`, `apply`, `revert` | 5               | 10          |

Fleet scan mode may scan up to five D1 pages of 50 saved packages per step while
applying filters, and can return a progress `nextCursor` even when the current
step matched zero packages.

### Modes

| Mode      | Behavior                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`    | Run `detect` only; record findings per package.                                                                                                                                                                                                                                                                                   |
| `dry-run` | Run `transform` in memory, then run the full publish check suite (`runRepoChecks`) on **both** the original and transformed trees. Pass only when transformed checks introduce **no new failures** compared to the original. Also verifies mechanical idempotency by transforming twice and requiring an unchanged second result. |
| `apply`   | Same gates as dry-run. On success: snapshot the original published tree to KV for revert, republish via `syncArtifactSourceSnapshot` with commit message `codemod(<id>): ...`, refresh the saved-package projection, and dispatch subscription events (see below). Re-checks drift immediately before publish.                    |
| `revert`  | For each `applied` item on a prior apply run: load the KV revert snapshot, verify published HEAD still matches that item's `afterCommit`, republish the snapshot tree, mark the source apply item `reverted`, and dispatch `package.codemod.reverted`.                                                                            |

Per-package failures are **isolated**; one package error does not abort sibling
items in the same run step.

### Run lifecycle

Runs are created as `running` and end `completed` only when a caller pages until
`nextCursor` is null. The other transitions keep the ledger honest when paging
stops early:

- **Heartbeat** — every step re-asserts `running` and bumps the run's
  `updated_at`, so `updated_at` doubles as a liveness signal. Continuing a
  `failed` or `abandoned` run reopens it.
- **`failed`** — written when a step throws at the run level (paging, ledger
  writes); per-item failures never fail the run.
- **`abandoned`** — written when the admin UI stops a run (stop button, step
  ceiling, stuck cursor) via `POST /admin/codemods/run/stop.json`, or by lazy
  reconciliation: loading the admin history marks `running` runs whose heartbeat
  is older than one hour. There is no scheduled sweeper; abandoned callers
  (closed tabs, agents that stopped paging) are caught on the next history load.

Abandoned and failed **apply** runs can still hold `applied` items; revert
accepts them (the admin UI only blocks revert while a run is `running`).

### Safety rails

- **`skipped_unpublished`** — packages with no published commit are skipped.
- **`skipped_drift`** — when Artifacts default-branch HEAD does not match
  `entity_sources.published_commit`, the engine skips and never overwrites.
  Apply re-checks drift after transform gates pass and before KV snapshot /
  publish. Revert compares HEAD to the prior apply item's **`afterCommit`**
  (post-codemod published commit); drift skips revert for that item.
- **Apply snapshots** — before publish, apply writes the pre-codemod published
  tree to `BUNDLE_ARTIFACTS_KV` at `package-codemod-revert:{userId}:{itemId}`
  with a **90-day TTL** and stores that key on the ledger item as
  `revert_snapshot_key`.
- **Check gate** — apply and dry-run both require the transformed tree to pass
  `runRepoChecks` without regressions versus the original tree.

### Item statuses

Each per-package row in a run records one of:

`detected`, `clean`, `dry_run_ok`, `dry_run_new_failures`, `needs_manual`,
`skipped_drift`, `skipped_unpublished`, `applied`, `reverted`, `failed`.

## Ledger

Every run and per-package item is stored in D1 (migration
`0111-package-codemod-ledger.sql`). Pagination cursors live on step responses,
not in the ledger tables.

**`package_codemod_runs`:** `id`, `codemod_id`, `mode`, `scope_user_id` (`NULL`
for fleet runs), `initiated_by_user_id`, `filters_json`, `status` (`running` |
`completed` | `failed` | `abandoned`), `revert_of_run_id`, `created_at`,
`updated_at`.

**`package_codemod_run_items`:** `id`, `run_id`, `user_id`, `package_id`,
`kody_id`, `status`, `before_commit`, `after_commit`, `changed_paths_json`,
`findings_json`, `check_summary_json`, `error`, `revert_snapshot_key`,
`created_at`, `updated_at`.

Ledger writes **bound** large text columns (`error`, `check_summary_json`,
`findings_json`, `changed_paths_json`) to restorable UTF-8 byte limits; findings
cap at 50 entries and changed paths at 200, with truncation notices when
overflowing.

The ledger makes runs **resumable** (page forward with `nextCursor`),
**auditable**, and **revertible** (revert reads KV snapshots keyed by
`revert_snapshot_key`). Revert is only possible while the KV snapshot remains
(90-day TTL). All rows are scoped by the owning user's saved package identity;
cross-user reads are a bug.

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
`package_codemod_revert` accepts a prior **apply** run id and reverts that
user's applied items — including items from a **fleet** apply run, as long as
the run is not scoped to another user (`scope_user_id` is `NULL` or matches the
caller).

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

Apply persists the pre-codemod published tree to KV (`revert_snapshot_key`,
90-day TTL) before republishing the transformed tree. **Revert** mode creates a
new run with `revert_of_run_id` pointing at the prior apply run, pages through
source items with status `applied`, loads each KV snapshot, and republishes via
`syncArtifactSourceSnapshot` with commit message `revert codemod(<id>)`. On
success it marks the **source apply item** `reverted`, refreshes projections,
and dispatches `package.codemod.reverted`.

Revert requires published HEAD to still equal the source item's `afterCommit`.
Missing or expired KV snapshots fail the revert item. Revert does not restore
Artifacts working-copy edits made after apply.

Runs are single-pass in every mode: items that fail or are drift-skipped are
recorded on the run but not retried within it. Because failed or skipped source
items keep their `applied` status, retrying is starting a **new** revert run
against the same apply run — it picks up exactly the items that were not
reverted.

Steps do not take a per-package lock. Publishes serialize in the repo session
Durable Object and transforms are deterministic, so overlapping steps of the
**same** codemod are benign, but do not fleet-apply two **different** codemods
concurrently — the second may transform stale published source.

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
