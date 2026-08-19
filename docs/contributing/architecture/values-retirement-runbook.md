# Values retirement runbook

Executable plan for retiring the values primitive (ADR
[0022](../decisions/0022-retire-values-primitive.md)). Landing this document
does **not** change production behavior.

Intended cadence is about thirty days. Removal waits for the gates in
[Retirement criterion](#retirement-criterion), the same metrics-then-cut pattern
as [0005](../decisions/0005-mcp-dual-lane-stateless-migration.md). If a later
readout fails a gate, reset that phase's clock.

## Destination map

Do not invent a replacement primitive.

| Job                                 | Destination                                                        | Production examples (2026-08-19)                           |
| ----------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Platform UI dismiss                 | `users.onboarding_checklist_dismissed_at`                          | `onboardingChecklistDismissed` (operator + several others) |
| Durable facts / preferences         | memories (`meta_memory_*`, verify-first)                           | address, timezone, profile blobs                           |
| Package runtime state / cache       | `packageStorage()`                                                 | automation state/plan keys, chunked job/blob names         |
| Versioned calibration               | plain repo (live-at-HEAD)                                          | shade config already on a live-at-HEAD repo                |
| Package-owned knobs                 | `packageStorage()` or a file in that package repo                  | detector / package setting keys                            |
| Shared ids used by several packages | owning package export, or one small settings package others invoke | Discord channel ids, org/app ids                           |
| OAuth client ids                    | integrations / platform OAuth apps                                 | `*ClientId` / `*-client-id` names                          |
| Credentials                         | secrets                                                            | bearer-token-like rows (readable + searchable today)       |

`app` and `session` scopes have no production rows. Do not migrate them; delete
the unused buckets with the tables.

## Agent channel

Do not dump this runbook into always-on MCP instructions. Agents for users who
still have at least one non-expired stored value get a one-line notice from
`retiringPrimitiveNotices`
(`packages/worker/src/mcp/instructions/retiring-primitives.ts`) that points at
`coding_guide_get({ guide: "values" })`. Users with no value rows (or only an
empty / expired bucket) do not see the section. The destination map and steps
live in `docs/guides/values.md`. An empty active-notice set omits the section,
so later retirements reuse the same slot: add a notice plus a coding guide and a
cheap EXISTS gate, then delete both when the primitive is gone.

This PR ships that per-affected-user notice and guide. Later phase-1 work still
moves onboarding dismiss, bearer-token-like rows, write-result hints, and
insights counts.

## Production inventory (baseline, 2026-08-19)

Read-only D1 counts on `kody` (`value_buckets` ⨝ `users`). Names only; no stored
contents.

- 62 accounts, 19 users with a value bucket, 18 with ≥1 row, **122** rows
- All rows `scope = 'user'`
- Operator account: 66. Others: 56 across 17 accounts
- Five users have only `onboardingChecklistDismissed`
- One account has an empty user bucket (0 rows)
- Heaviest non-operator store: 27 chunked keys

Re-query the same aggregates before each phase gate. Admin MCP never returns
other users' values; use the Kody Cloudflare account D1 query path (or the
insights counts added in phase 1).

```sql
SELECT
	(SELECT COUNT(*) FROM value_buckets) AS buckets,
	(SELECT COUNT(*) FROM value_entries) AS entries,
	(SELECT COUNT(DISTINCT user_id) FROM value_buckets) AS users_with_buckets;

SELECT vb.scope, COUNT(*) AS buckets
FROM value_buckets vb
GROUP BY vb.scope;
```

## Phases

### Phase 0 — Record the decision and tell agents (this change)

Ship ADR 0022, this runbook, the per-affected-user retiring-primitives
instruction notice, and the `values` coding guide. `value_set` still writes.
`primitives.yaml` still lists `values` until the removal PR.

### Phase 1 — Stop the bleeding (week 1)

Goal: the platform stops _creating_ reasons to use values, and the one security
smell leaves the readable store.

1. **Move onboarding dismiss off values.** Add
   `users.onboarding_checklist_dismissed_at` (nullable ISO timestamp). Backfill
   from `onboardingChecklistDismissed`, then stop reading/writing that value
   name. The operator account plus six others drop off values without a user
   action.
2. **Move bearer-token-like rows to a secret** (operator). Values entity detail
   prints the stored string; bearer tokens must not live there.
3. **Tell agents in server instructions.** Keep a `retiringPrimitiveNotices`
   registry (`packages/worker/src/mcp/instructions/retiring-primitives.ts`).
   Each notice is one line plus `coding_guide_get({ guide })`, and
   `loadActiveRetiringNoticeIds` includes the values notice only when that user
   still has a live stored value. The destination map lives in
   `docs/guides/values.md` (id `values`), not in the always-on instruction
   string. An empty active set omits the section. Future retirements add a
   notice + guide + EXISTS gate the same way. Also stop recommending values in
   execute tool text, capability descriptions, usage docs, and project-intent's
   isolation list.
4. **Deprecate writes in place.** `value_set` and `POST /account/values.json`
   still succeed. Responses and the account UI include a deprecation notice and
   a destination hint (table above). Do not add a new MCP capability for this —
   keep the compact surface; put guidance on the existing write result,
   `/account/values`, and the `values` coding guide.
5. **Watch the fleet.** Admin insights totals gain `value_entries` and
   `users_with_value_rows` (counts only, no names or contents). That is the
   phase dashboard; remove the counters with the primitive.
6. **Retire values as the preview-manual-test example.** Point
   `docs/contributing/preview-manual-testing.md` and the skill at a surface that
   will survive (memories, secrets metadata, or the new onboarding column).

Do **not** auto-upsert memories from values (verify-first). Do **not** hide
`value_get` / `value_list` / search-entity `value` yet — agents need them to
migrate.

### Phase 2 — Assisted migration (weeks 2–3)

Goal: remaining rows have an owner and a destination. Reads stay live.

**Platform / Kent packages (can parallelize with outreach):**

- Finish shade/HRV/thermostat: runtime state in `packageStorage()`, calibration
  in `home-automation-config` (shade already documents this). Stop writing
  `shadeAutomationPlan` / `State` as user values.
- Shared Discord / org ids: one export on the owning package (or a tiny settings
  package) that other packages invoke. Do not leave them as user-global kv.
- Chunked documents (`css-fix-*`, invite template, mission word counts): repos.
- Token metadata (`epicProductEngineerToken*`): secrets + a memory for the
  policy, or the owning package's storage.

**Other users (aggregates from the baseline; do not read their contents):**

| Pattern (anonymized)                | Accounts     | Suggested dest                               |
| ----------------------------------- | ------------ | -------------------------------------------- |
| Chunked job/blob keys               | 1 (27 rows)  | `packageStorage()` / a repo                  |
| Package detector / setting keys     | 1 (5 rows)   | owning package storage or repo               |
| OAuth client ids and leftover URLs  | 9 (1–5 each) | integrations; leftover URLs → owning package |
| Profile blob                        | 1            | memory                                       |
| Only `onboardingChecklistDismissed` | 5            | done in phase 1 after onboarding backfill    |
| Empty bucket                        | 1            | dropped with the tables                      |

Outreach is a short Discord note plus the account-page banner: values go away;
here is `value_list` and the destination table. Community listings that still
say `value_get` (for example Bluesky + `blueskyHandle`) update when those
packages are touched.

Optional helper, only if agents keep stuffing new rows: a **read-only**
classifier in the `value_list` / account UI result (`suggestedDestination`), not
a new domain.

### Phase 3 — Write freeze (week 4)

Add registry flag `values-writes` (default enabled). When disabled:

- `value_set` and account save reject **new names** with a destination hint
- updates to existing names stay allowed for a few days, then reject too
- `value_get` / `value_list` / `value_delete` / search / account read stay
- hide `/account/values/new`

Flip the flag globally when phase 2 outreach has landed and insights show
new-name writes near zero. Per-user override on if someone still needs a last
update. Rollback is re-enabling the flag.

### Phase 4 — Remove the primitive

Only after [Retirement criterion](#retirement-criterion).

Expand/contract: one deploy with capabilities, search plugin, account routes,
and MCP instructions gone (reads may still 404-with-guidance for one release); a
follow-up migration drops `value_entries` / `value_buckets` after account export
has a final snapshot. Same change updates `primitives.yaml` (delete `values`),
entitlements storage math, export/deletion targets, package-app-scoped cleanup,
onboarding leftovers, and preview fixtures.

Do not drop the D1 tables in the same deploy that first disables reads.

## Retirement criterion

Re-run the inventory queries. Remove the primitive when **all** hold for the
**seven days** immediately before the removal PR:

1. Platform code does not read or write `value_entries` except the deprecated
   capability implementations themselves.
2. `onboardingChecklistDismissed` has **zero** rows (backfill + cutoff done).
3. Admin insights `value_entries` is **unchanged or falling**, and `value_set` /
   account-save writes are **near zero** (no new names; leftover updates only
   from the freeze overrides).
4. Every remaining row has a recorded destination (migrated, exported, or owner
   notified). Empty buckets do not block.
5. `values-writes` has been globally off for those seven days without a
   rollback.

If (3) or (5) fails, keep reads and reset the seven-day window. Do not delete on
day 30 because the calendar said so.

## What not to do

- Do not add `account_settings`, `user_kv`, or a new MCP domain to replace
  values.
- Do not auto-write memories from values.
- Do not keep values because secrets exist. Secrets stay.
- Do not treat "agents like `value_get`" as a primitive. That is
  `packageStorage().get` / `set`, or a package export.
- Do not query other users' stored contents during this migration. Counts,
  names, and scopes are enough.

## Related

- [0002 — Data placement](../decisions/0002-data-placement.md) (values-in-D1
  becomes moot)
- [0003 — Repos as the base primitive](../decisions/0003-repos-as-base-primitive.md)
- [0005 — Metrics-driven lane retirement](../decisions/0005-mcp-dual-lane-stateless-migration.md)
- [Package state model](../../use/packages.md#package-state-model)
