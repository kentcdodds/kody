# Values retirement runbook

Executable plan for retiring the values primitive (ADR
[0022](../decisions/0022-retire-values-primitive.md)).

## Status

Writes are gone. `value_set` is not a capability. `POST /account/values.json`
save is gone. Search, domain listing, MCP instructions, and `values:guide`
advertisements do not mention values. The unadvertised `values` guide stays
callable by exact entity id. `primitives.yaml` has no `id: values` entry.

`valueGet` / `valueList` / `valueDelete` remain as an unadvertised drain until
the D1 tables drop. `/account/values` stays as an operator drain and is not in
account nav. There is no `values-writes` feature flag.

Live leftover count as of 2026-08-24: 19 buckets / 46 entries / 19 users; 0
`onboardingChecklistDismissed` leftovers.

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

Do not dump this runbook into always-on MCP instructions. The destination map
lives in `docs/guides/values.md` and stays unadvertised. An empty
`retiringPrimitiveNotices` registry omits the section.

## Remaining work

Expand/contract leftover: keep the unadvertised drain until leftover rows are
gone, then drop `valueGet` / `valueList` / `valueDelete` and the `value_entries`
/ `value_buckets` tables. Do not drop the D1 tables in the same deploy that
first disables reads. Account export should have a final snapshot before the
drop.

Re-query leftover counts before the table-drop PR:

```sql
SELECT
	(SELECT COUNT(*) FROM value_buckets) AS buckets,
	(SELECT COUNT(*) FROM value_entries) AS entries,
	(SELECT COUNT(DISTINCT user_id) FROM value_buckets) AS users_with_buckets;
```

## What not to do

- Do not add `account_settings`, `user_kv`, or a new MCP domain to replace
  values.
- Do not auto-write memories from leftover rows.
- Do not keep values because secrets exist. Secrets stay.
- Do not query other users' stored contents during this migration. Counts,
  names, and scopes are enough.
- Do not document a `values-writes` feature flag unless it is in
  `packages/worker/universal/feature-flags/registry.ts`.

## Related

- [0002 — Data placement](../decisions/0002-data-placement.md) (values-in-D1
  becomes moot)
- [0003 — Repos as the base primitive](../decisions/0003-repos-as-base-primitive.md)
- [0005 — Metrics-driven lane retirement](../decisions/0005-mcp-dual-lane-stateless-migration.md)
- [Package state model](../../use/packages.md#package-state-model)
- [Cleanup after migrations](../cleanup-after-migrations.md) (GitHub issue for
  leftovers that wait on a later drop)
