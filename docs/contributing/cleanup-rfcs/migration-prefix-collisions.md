# RFC: D1 migration prefix collisions

Status: draft, open for discussion. No source code changes are proposed in this
RFC; the goal is to pick a path and then implement it (or its guardrail) in a
follow-up PR.

## Background

`packages/worker/migrations/` is the directory Wrangler reads when running
`d1 migrations apply` (see `npm run migrate:local`, the `migrate:e2e` script,
and the production / preview `d1 migrations apply APP_DB --remote` invocations
documented in `docs/contributing/setup.md`). Wrangler determines the order of
migrations by sorting filenames lexicographically and tracks which migrations
have been applied to a given database in the D1 `d1_migrations` table, keyed by
the **exact filename** (without extension).

Four numeric prefixes are duplicated today, the result of two parallel feature
branches each picking the next free number and both landing in `main`:

| Prefix | Files                                                              |
| ------ | ------------------------------------------------------------------ |
| `0009` | `0009-secret-allowed-hosts.sql`, `0009-ui-artifact-parameters.sql` |
| `0010` | `0010-secret-allowed-capabilities.sql`, `0010-value-buckets.sql`   |
| `0018` | `0018-jobs.sql`, `0018-mcp-memory-source-uris.sql`                 |
| `0023` | `0023-entity-sources.sql`, `0023-secret-allowed-packages.sql`      |

Because Wrangler sorts the full filename, ties on the numeric prefix are broken
by the slug, so the apply order today is deterministic — but it is determined by
alphabetical accident, not by the order the PRs landed. Production, preview, and
every developer's local D1 already have these eight files recorded in
`d1_migrations` under these exact names.

## 1. Risk assessment

### What actually breaks today

Nothing observable. Concretely:

- Wrangler still produces a stable apply order: for any colliding prefix N, the
  file whose slug sorts first is applied first, then the second. New D1
  databases and CI databases get the same order each time.
- All four colliding pairs are _additive_ (new tables and indexes only); no pair
  has a write-ordering dependency between the two members, so the alphabetical
  ordering does not produce a different schema than would intent-ordered
  application.
- The legacy-inline-sources test
  (`packages/worker/src/repo/legacy-inline-sources-migration.node.test.ts`)
  intentionally exercises only the subset of files relevant to that flow, and it
  picks `0009-ui-artifact-parameters.sql` and `0023-entity-sources.sql` by exact
  name, sidestepping the ambiguity entirely.

### What could break tomorrow

The risk is structural and cumulative, not immediate:

- **Fifth collision.** Every new migration PR that picks "next prefix" must
  rebase if a different PR with the same prefix lands first; if a contributor
  forgets, we land another duplicate. The risk grows with PR concurrency.
- **Confusion when reading history.** A developer skimming the directory cannot
  tell which `0018` ran first without inspecting both files or the D1
  applied-migrations table.
- **Tooling fragility.** Anyone who writes a script that derives the next prefix
  by `max(prefix) + 1` or that diffs migration sequences across branches will be
  surprised by ties. We do not have such a script today, but any future
  "validate migrations" lint or any external tool (e.g. a CI bot that suggests
  the next prefix) needs to be collision-aware.
- **A non-additive collision is a real footgun.** None of the current four pairs
  reorders data, but the convention currently allows two PRs to land with the
  same prefix where one is `ALTER TABLE` and the other is `DROP COLUMN` of an
  overlapping column. Wrangler would resolve the order by slug alphabetics, and
  the _intended_ dependency could be silently violated. This is the strongest
  argument for a guardrail even if we never rename anything.
- **D1 applied-migrations table is keyed by filename.** This is a constraint
  that hard-locks the names we already shipped (see Option B). It also means any
  rename has to be coordinated across all environments at once.

## 2. Option A — Do nothing, add a forward-only guardrail

### When it's acceptable

When the cost of a coordinated rename across production / preview / every
developer's local D1 outweighs the marginal hygiene benefit, **and** we can
prove we will not ship a fifth collision. Today, all four pairs are
order-insensitive and the schema is stable, so doing nothing is operationally
safe.

### Required guardrails

1. **Lint check that fails on duplicate prefixes for new files.** Concretely:
   compute the set of `^[0-9]{4}` prefixes that appear in `migrations/` on
   `main`, treat that set as the grandfathered baseline, and fail CI if any
   prefix in the current branch's `migrations/` directory has a count strictly
   greater than its count on `main`. This:
   - grandfathers the four existing duplicates (they keep their count of 2);
   - blocks any _new_ prefix appearing more than once;
   - blocks adding a third file with an already-duplicated prefix (e.g. a third
     `0018-*.sql`). The check can live as a small Node script invoked by
     `npm run validate` and/or as an oxlint plugin; either way it must run
     before merge.
2. **Document the rule.** Update `docs/contributing/setup.md` (see § 6) to
   describe how to pick a prefix and what the lint check enforces.
3. **Optional extra check.** Fail CI if any file in `migrations/` is _modified_
   on a branch but exists on `main` (Wrangler will not re-apply it, so the
   change has no effect on already-applied environments). This already exists
   informally as the "do not edit landed migration files" rule in `setup.md`;
   turning it into a check is a small additional cost.

### Cost / benefit

Low cost, low benefit. We accept that the directory listing is forever slightly
ugly but we never have to touch production. This is the cheapest path to make
the problem stop growing.

## 3. Option B — Rename on disk

### What renaming actually does

Wrangler reads `d1_migrations` to decide which files to skip. Rows in that table
are keyed by the filename (sans extension) that Wrangler saw at apply time. So
if we rename `0018-jobs.sql` → `0018a-jobs.sql` on disk and push, the next
`d1 migrations apply` against any environment that already has `0018-jobs`
recorded will:

1. See `0018a-jobs.sql` in the directory.
2. Look up `0018a-jobs` in `d1_migrations` and not find it.
3. **Re-execute the entire file.** For most of our migrations this means
   `CREATE TABLE jobs (...)` against a database that already has a `jobs` table
   → `SQLite error: table jobs already exists` and the apply aborts. For
   migrations that include `DROP` statements (e.g.
   `0026-drop-legacy-inline-sources.sql`-style cleanup), re-running them would
   silently destroy data.

In short: a naive rename is destructive. The destruction is loud (apply fails)
for the additive migrations, which is the entire colliding set, but the failure
mode means CI / preview / production will refuse to deploy until the operator
manually patches `d1_migrations`.

### Mitigation: coordinated `UPDATE d1_migrations`

The only safe way to rename an applied migration is to update the D1 ledger in
the same change that renames the file, and to do it against every environment
that has the old name applied. Concretely, for each rename:

```sql
UPDATE d1_migrations SET name = '0009a-secret-allowed-hosts'
WHERE name = '0009-secret-allowed-hosts';
```

(D1 stores the name without the `.sql` extension.) The ledger update must run
against:

- every developer's local Wrangler state directory (`.wrangler/state/d1/...` —
  and the e2e variant `--persist-to .wrangler/state/e2e`),
- the preview database (`CLOUDFLARE_ENV=preview ... --remote`),
- the production database (`--remote`, default env).

It must run **before** the next `d1 migrations apply`, otherwise apply will fail
as described above.

### Operationally that means

1. A small migration tool / script in `tools/` that emits the `UPDATE`
   statements idempotently (`WHERE name = ...`).
2. Running that script against every remote D1 in lockstep with the merge of the
   rename PR. Realistically: pause deploys, run the ledger updates against
   preview and production, merge the rename PR, redeploy.
3. Telling every contributor with a populated local D1 to either run the tool
   against `--local` or wipe and re-migrate (`docs/contributing/setup.md`
   already documents the reset flow, so the second option is cheap).
4. Eight test-file references (see § 7) get updated in the same PR.

### Worth it?

**No, not for the four current collisions.** The migrations are additive, the
ordering is stable, and the only practical benefit of renaming is aesthetic. The
cost is a coordinated production change with a window in which any apply against
an environment whose ledger has not been patched will fail. The blast radius is
small (additive migrations only) but the process risk is real (we have to run
privileged SQL against production to fix something that is not actually broken).
This option is worth keeping in our pocket for the day a _non-additive_
collision lands and we genuinely need to reorder, but it is not justified
preemptively.

## 4. Option C — Squash early migrations into a single baseline

### What it looks like

Replace `0001-init.sql` through some cutoff `00NN-...sql` with a single
`0001-baseline.sql` that is the schema-equivalent `CREATE TABLE` /
`CREATE INDEX` statements for the result of running the originals in their
canonical order. New migrations continue from `00NN+1`.

For each environment that already has the originals applied, we mark
`0001-baseline` as applied (`INSERT INTO d1_migrations`) and delete the rows for
the originals (or leave them — Wrangler ignores ledger entries with no matching
file). New databases (CI shards, fresh preview, future environments) bootstrap
from the single baseline file in one step.

If the cutoff is chosen at or after the last colliding prefix (≥ `0023`), all
four collisions disappear by construction; the baseline is one file, so it
cannot collide with itself.

### Cost

- **Production ledger surgery, same as Option B but bigger.** The
  `INSERT`/`DELETE` against `d1_migrations` has to run against every environment
  in lockstep with the merge.
- **Loss of git-grep history for migration intent.** Today `0018-jobs.sql` is
  the canonical record of how the jobs table was introduced. After squash, that
  file is gone from `migrations/`; the history still exists in git but is no
  longer reachable by directory listing. Mitigation: keep the originals under
  `migrations/_archive/` so they remain searchable but are not picked up by
  Wrangler.
- **Test rewrites.** Every test that uses `readMigration('00NN-...')` for a file
  inside the squash range has to be rewritten to consume the baseline file (or a
  hand-curated subset). The legacy-inline-sources test is the worst case because
  it reads a curated _subset_ of early migrations to reconstruct a specific
  historical state — it cannot trivially switch to the baseline because the
  baseline collapses intermediate states. See § 7 for the concrete file list.
- **Reviewer cost.** Diffing a hand-written `0001-baseline.sql` against the
  cumulative result of running the originals is a manual exercise. It is
  feasible but requires care.

### Benefit

- One-time cleanup. Once done, the directory is collision-free by construction
  up to the cutoff, and any further collisions are easy to remediate by
  squashing again or by Option B against a smaller window.
- New-developer / new-environment bootstrap is faster (one apply, not
  thirty-six).

### Worth it?

Probably not in isolation. Squashing is a high-leverage one-time move when the
migration directory has grown unwieldy _and_ the collision problem is bad enough
to justify the production ledger surgery. We are not at that point yet (36
files, 4 cosmetic collisions). It becomes the right call if we cross some
threshold — say, > 100 migrations or a non-additive collision in production —
and at that point it absorbs the collision cleanup as a side effect.

## 5. Recommended path

**Adopt Option A now (forward-only lint + numbering convention) and keep Option
C as the planned response if migrations grow large enough to warrant a baseline
squash.** Skip Option B unless we hit a _non-additive_ collision that actually
requires reordering on a live database.

Justification: the existing four collisions are operationally inert (ordering is
stable, all pairs are additive, the affected tests already disambiguate by exact
filename). The real risk is recurrence — a fifth collision that happens to be
order-sensitive. A grandfathered duplicate- prefix lint check fixes recurrence
without touching production. Renames or squashes both require coordinated
`d1_migrations` writes against every environment, which is a meaningful
operational cost we should not pay for an aesthetic win.

**Decision rule:**

- If a future collision is additive and order-insensitive → do nothing beyond
  the lint guardrail; let the directory carry the duplicate, the same way it
  carries the four current ones.
- Otherwise (non-additive collision, or directory has grown unwieldy and we want
  a baseline anyway) → Option C with `_archive/` retention of the originals.
  Reach for Option B only if Option C is not feasible (e.g. we need to fix one
  specific file's order without touching the rest of the directory).

## 6. Migration-numbering convention going forward

This is the proposed change to `docs/contributing/setup.md` (or, if we prefer a
dedicated page, `docs/contributing/migrations.md`). We are not making that edit
in this RFC — it lands with the lint check in the follow-up PR.

> ### Authoring a new D1 migration
>
> 1. Read the current `packages/worker/migrations/` directory and pick
>    `(max numeric prefix) + 1`, zero-padded to four digits. Example: if the
>    last file is `0036-...`, your new file is `0037-<slug>.sql`.
> 2. If your branch sits behind `main` and a new migration has landed upstream
>    with the prefix you picked, **rebase and renumber**. Do not commit a
>    duplicate prefix; CI will reject it (see the duplicate-prefix lint check,
>    which grandfathers prefixes 0009, 0010, 0018, and 0023 from before this
>    rule existed).
> 3. Once a migration file lands in `main` and is deployed, treat the filename
>    as immutable (existing rule). Schema corrections ship as a new migration.
> 4. If a colliding prefix slips through review, the fix is a follow-up PR that
>    renames the _not-yet-deployed_ file (Wrangler has no ledger entry for it
>    yet, so renaming is safe). If both files have already deployed, leave them;
>    do not rename live migrations.

We should also surface the rebase-and-renumber expectation in the PR template or
the agent / contributor docs that describe how to add a schema change.

## 7. Files / tests that hardcode colliding filenames

Any rename has to update these references in the same change. None of these
files are modified by this RFC.

### Tests

- `packages/worker/src/repo/legacy-inline-sources-migration.node.test.ts` —
  applies a curated list of migrations including
  `0009-ui-artifact-parameters.sql`, `0018-jobs.sql`, and
  `0023-entity-sources.sql` (exact filename literals; lines ~29–44 and
  ~187–188). Notably, this test does **not** apply
  `0009-secret-allowed-hosts.sql`, `0010-secret-allowed-capabilities.sql`,
  `0010-value-buckets.sql`, `0018-mcp-memory-source-uris.sql`, or
  `0023-secret-allowed-packages.sql`, so it implicitly relies on each colliding
  pair being independent.
- `packages/worker/src/jobs/jobs-codemode-only-migration.node.test.ts` — applies
  `0018-jobs.sql`, `0019-jobs-constraints.sql`, `0020-jobs-codemode-only.sql`,
  `0021-jobs-storage-id.sql` by exact filename (lines 14–15 and 82–83).
- `packages/worker/src/email/unified-email-receipt-migration.node.test.ts` —
  applies `0030-email-primitives.sql` and `0031-unified-email-receipt.sql`
  (lines 14 and 69). Not in the colliding set today, but listed because it uses
  the same `readMigration(name)` helper and would need to be revisited under
  Option C if the squash cutoff includes prefix 0030.

### Helpers

- The `readMigration` helper (defined locally and identically in each of the
  three `*-migration.node.test.ts` files) resolves filenames against
  `packages/worker/migrations/` via `import.meta.url`. Any rename plan is also a
  chance to consolidate this helper in a shared module, but that is out of scope
  for this RFC.

### Production / preview ledgers

- The D1 `d1_migrations` table on production, preview, and every developer's
  local Wrangler state directory contains rows for all eight colliding filenames
  (extension stripped). Options B and C both require coordinated writes against
  every one of these ledgers; Option A leaves them untouched.

### Tooling

- `package.json` scripts `migrate:local`, `migrate:e2e`, and the documented
  `d1 migrations apply APP_DB --remote` invocations in
  `docs/contributing/setup.md` reference the directory but no specific filename.
  They are unaffected by any of the three options.

## Appendix: where this fits

This is the first entry under `docs/contributing/cleanup-rfcs/`. Other candidate
cleanups (e.g. consolidating the three `readMigration` helpers, or formalizing
the migrations-immutability rule into a CI check) can land as siblings here.
