# Authoring D1 migrations

Naming, ledger rules, and what not to edit after a migration lands. See the
[setup index](./index.md) for the other setup pages. Remote apply examples live
in [Seed test account](./seeding.md).

- New migration files live in `packages/worker/migrations/` and are applied in
  lexicographic filename order by Wrangler (`npm run migrate:local`,
  `migrate:e2e`, and the documented `d1 migrations apply APP_DB --remote`
  invocations in [Seed test account](./seeding.md)).
- Name new files `NNNN-kebab-case-description.sql` (four-digit prefix, hyphen,
  kebab-case slug). Pick the next prefix as `(max numeric prefix) + 1`,
  zero-padded to four digits (for example, if the highest prefix is `0075`, use
  `0076-my-change.sql`).
- If your branch is behind `main` and a new migration has landed upstream with
  the prefix you picked, rebase and renumber your file to a new unused prefix.
  Do not introduce new duplicate prefixes.
- Do not edit migration files that have already landed in `main` and been
  deployed. New migration files that only exist on your branch can be revised
  freely until they land in `main`; once deployed, any schema correction should
  ship as a new migration instead.
- `npm run migrations:check` (also run by `npm run validate` and the pre-commit
  hook) enforces the naming rules above against the checked-in, append-only
  `tools/migration-ledger.json`. When adding a migration, append its filename
  and SHA-256 digest to the ledger; never edit or remove an existing ledger
  entry. The check compares historical entries and SQL contents with a
  pre-change Git commit: CI supplies the PR base or push-before SHA, local
  branches use their `main` merge base, and main/detached checkouts fall back to
  the first parent. `HEAD` itself is never trusted. CI fetches complete history;
  local and cloud checkouts must retain or fetch `origin/main`. If no pre-change
  commit is available, validation fails safely once migrations exist beyond the
  frozen bootstrap baseline. Migration SQL is hashed with canonical LF line
  endings, and `.gitattributes` enforces LF checkouts.
- Duplicate prefixes are always rejected. The 2026-08-04 migration-history
  squash collapsed the pre-launch history into `0001-squashed-init.sql` (full
  schema plus migration-seeded platform rows); the pre-squash files remain in
  Git history only. `tools/ci/reset-migration-bookkeeping.ts` is the
  deterministic guard that rewrote `d1_migrations` bookkeeping in existing
  databases — it verifies the applied set matches the frozen pre-squash list
  exactly before touching anything, and no-ops on fresh or already-squashed
  databases. The guard runs only for local applies against pre-squash developer
  state dirs; delete it once those have died out.
- Leftovers this migration cannot drop yet (old columns, dual-write, a later
  `deleted_classes` tag, a soak) follow
  [Cleanup after migrations](../cleanup-after-migrations.md): remove them in
  this change when safe, otherwise open a GitHub issue.
