# Values retirement runbook

Executable plan for retiring the values primitive (ADR
[0022](../decisions/0022-retire-values-primitive.md)).

## Status

The product surface is gone. `value_get`, `value_list`, `value_delete`, and the
`value_set` hard-error are not capabilities. `/account/values`, its JSON API,
search `userValueRows`, and `guide:values` are gone. Account export, deletion,
org transfer, soft-delete, entitlements byte math, and package cleanup no longer
read `value_entries` or `value_buckets`. `primitives.yaml` has no `id: values`
entry.

The tables remain until a later deploy adds
`DROP TABLE IF EXISTS value_entries; DROP TABLE IF EXISTS value_buckets;`. Do
not edit applied migrations. Production rows were deleted on 2026-10-16 (0
buckets / 0 entries). They are covered by disaster-recovery snapshots; the D1
Time Travel bookmark taken immediately before that delete is
`00001342-0001140b-00005106-b32c81967388d0713bcd60dfa9e01c3a`.

## Destination map

Do not invent a replacement primitive.

| Job                                 | Destination                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Platform UI dismiss                 | `users.onboarding_checklist_dismissed_at`                                     |
| Durable facts / preferences         | memories (`meta_memory_*`, verify-first)                                      |
| Package runtime state / cache       | `packageStorage()`                                                            |
| Versioned calibration               | plain repo (live-at-HEAD)                                                     |
| Package-owned knobs                 | `packageStorage()` or a file in that package repo                             |
| Shared ids used by several packages | owning package export, or one small settings package others statically import |
| OAuth client ids                    | integrations / platform OAuth apps                                            |
| Credentials                         | secrets                                                                       |

## Remaining work

Drop the two tables in the deploy after this code removal. Tracked by
[#1728](https://github.com/kentcdodds/kody/issues/1728).

## What not to do

- Do not add `account_settings`, `user_kv`, or a new MCP domain to replace
  values.
- Do not auto-write memories from leftover rows.
- Do not keep values because secrets exist. Secrets stay.
- Do not drop the tables in the same deploy that first disables reads.
- Do not document a `values-writes` feature flag unless it is in
  `packages/worker/universal/feature-flags/registry.ts`.

## Related

- [0002 — Data placement](../decisions/0002-data-placement.md) (values-in-D1
  becomes moot when the tables drop)
- [0003 — Repos as the base primitive](../decisions/0003-repos-as-base-primitive.md)
- [0005 — Metrics-driven lane retirement](../decisions/0005-mcp-dual-lane-stateless-migration.md)
- [Package state model](../../use/packages.md#package-state-model)
- [Cleanup after migrations](../cleanup-after-migrations.md)
