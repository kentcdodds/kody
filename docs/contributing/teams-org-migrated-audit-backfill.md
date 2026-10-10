# Teams org.migrated audit backfill

ADR 0063 records one `org.migrated` success row in `org_audit_events` (AUDIT_DB)
for each org in APP_DB. The row is observability. Auth does not read it. A D1
migration cannot see both databases, so the insert lives in
`backfillOrgMigratedAuditEvents`
(`tools/teams-migration/backfill-org-migrated-audit.ts`).

Deploy does not run it. An operator runs the command, or the manual workflow,
after the expand migrations are on the target.

## What it does

- Reads `orgs.id` from APP_DB.
- Skips an org that already has `action = 'org.migrated'` and
  `result = 'success'` in AUDIT_DB.
- In `dry-run`, prints counts and writes nothing.
- In `apply`, inserts each missing success row with one conditional statement
  per org (`INSERT ... SELECT ... WHERE NOT EXISTS`). `inserted` is the total
  number of rows those statements wrote. A second apply inserts nothing. An
  interrupted apply keeps the rows already written.
- Audit migration `0003-org-migrated-success-unique.sql` allows one success row
  per org. A `failure` row does not count, so apply still writes the success
  row. If one org already has two success rows, 0003 stops and leaves those rows
  in place.

The public log is counts and database names (`orgs`, `pending`, `present`,
`inserted`). It does not list org ids.

## Workflow

`.github/workflows/teams-org-migrated-audit-backfill.yml`
(`🧾 Teams org.migrated audit backfill`) is `workflow_dispatch`. It needs the
Actions secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`
(the same pair preview and production deploys use).

Preview (any dispatcher, no confirm). Run `dry-run` first:

```bash
gh workflow run teams-org-migrated-audit-backfill.yml --ref main \
  -f target=kody-pr-123 \
  -f mode=dry-run
gh workflow run teams-org-migrated-audit-backfill.yml --ref main \
  -f target=kody-branch-your-slug \
  -f mode=apply
```

`kody-pr-<number>` is a pull request preview. `kody-branch-<slug>` is a branch
preview. The script refuses any other name, so a preview target cannot resolve
to the production databases `kody` and `kody-audit`.

Production, from `main`, as `kentcdodds`. Dry-run and apply both need the
confirm phrase. To approve another runner, add their GitHub login to the
workflow check in a reviewed PR.

```bash
gh workflow run teams-org-migrated-audit-backfill.yml --ref main \
  -f target=production \
  -f mode=dry-run \
  -f confirm="backfill org.migrated audit"

gh workflow run teams-org-migrated-audit-backfill.yml --ref main \
  -f target=production \
  -f mode=apply \
  -f confirm="backfill org.migrated audit"
```

One run at a time per target (the workflow concurrency group). If apply stops
early, run it again: rows already written are skipped.

## Command

Same checks as the workflow, for an operator who already has
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment:

```bash
node tools/teams-migration/backfill-org-migrated-audit.ts \
  --target kody-pr-123 \
  --mode dry-run

node tools/teams-migration/backfill-org-migrated-audit.ts \
  --target production \
  --mode apply \
  --confirm "backfill org.migrated audit"
```

Production without that exact `--confirm` exits before any Cloudflare call.

## Tests

`tools/teams-migration/backfill-org-migrated-audit.node.test.ts` covers the
dry-run write barrier, a second apply that inserts nothing, preview database
names, and the production confirm gate.
