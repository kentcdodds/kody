# `packages.invoke` prefix migration

String-first `packages.invoke` accepts both `kody:@owner/package[/export]` and
the deprecated prefixless `@owner/package[/export]` form during this migration
phase. The parser canonicalizes the latter to `kody:`. Object-only invocation
remains removed, and publishing does not reject prefixless string-first calls.

Use permanent codemod `0007-prefix-packages-invoke-specifiers` to migrate
literal calls. It is intentionally separate from
`0006-invoke-object-to-specifier`, which retains responsibility for the removed
object-only API.

## Privacy-safe telemetry

Every string-first call is classified before parser canonicalization and written
to the dedicated production Analytics Engine dataset
`kody_package_invoke_specifier_events` (preview uses
`kody_package_invoke_specifier_events_preview`).

The schema is deliberately coarse:

| Field     | Value                                 |
| --------- | ------------------------------------- |
| `index1`  | `kody_prefixed` or `prefixless`       |
| `blob1`   | same form value                       |
| `blob2`   | `execute`, `package`, `job`, or `app` |
| `double1` | `1`                                   |

No user, package, specifier, export, params, source, run, request, or
conversation identity is recorded. Recording is nonthrowing and a no-op where
the binding is absent.

Attribution is deterministic: a parent job run selects `job`; otherwise an app
runtime marker selects `app`; otherwise an execute caller selects `execute`; all
remaining calls select `package`.

## Exact retirement query

Run this query against `kody_package_invoke_specifier_events`. Replace only the
two UTC timestamp literals, using Analytics Engine's accepted
`YYYY-MM-DD HH:MM:SS` format. The start must be after the telemetry deploy
completed; the end must be after the observation window closed.

```sql
SELECT
  blob2 AS surface,
  COUNT(*) AS retained_samples_total,
  SUM(_sample_interval) AS weighted_calls_total,
  SUM(
    CASE WHEN blob1 = 'prefixless' THEN _sample_interval ELSE 0 END
  ) AS weighted_prefixless_calls,
  SUM(
    CASE WHEN blob1 = 'kody_prefixed' THEN _sample_interval ELSE 0 END
  ) AS weighted_kody_prefixed_calls
FROM kody_package_invoke_specifier_events
WHERE timestamp >= toDateTime('2026-08-01 00:00:00')
  AND timestamp < toDateTime('2026-08-08 00:00:00')
  AND blob1 IN ('prefixless', 'kody_prefixed')
  AND blob2 IN ('execute', 'package', 'job', 'app')
GROUP BY blob2
ORDER BY blob2
```

Analytics Engine can sample high-volume data. Each retained row represents
`_sample_interval` source events. The weighted sums estimate workload coverage;
`retained_samples_total` measures how many rows actually support that estimate.
Both are required by the gate below.

## Cleanup gate

Remove prefixless runtime support only when one query window proves all of the
following:

- `execute`, `package`, and `job` each independently have exactly `0`
  `weighted_prefixless_calls`, at least `300` `weighted_calls_total`, and at
  least `30` `weighted_kody_prefixed_calls`. Each must also have at least `300`
  `retained_samples_total`.
- `app` is observed in every readout. If it has any traffic, it must meet the
  same weighted `0` / `300` / `30` thresholds and the same
  `retained_samples_total >= 300` floor independently. A missing app row means
  no app traffic and does not block cleanup.

Do not combine surfaces to reach a threshold. Execute, package, and job are
historically active and each must pass independently.

Weighted thresholds measure estimated workload coverage, but a few retained rows
with large `_sample_interval` values must not satisfy the gate by themselves.
The 300-row retained-sample floor provides that independent evidence-quality
check. Analytics Engine uses adaptive sampling, and events are indexed by form,
so neither weighted totals nor retained rows justify a formal binomial
confidence interval. This is a conservative operational gate, not a claimed 95%
bound. The independent minimum of 30 weighted `kody_prefixed` calls still
prevents a dead or miswired telemetry path from looking safe merely because it
reported zero deprecated calls.

Attach the following evidence to the final cutover:

1. The exact query text used, unchanged except for its timestamp literals.
2. Dataset name `kody_package_invoke_specifier_events`.
3. Exact start and end UTC timestamps in ISO 8601 form alongside the executed
   query. The evidence timestamps correspond exactly to the UTC values passed to
   `toDateTime(...)`; ISO formatting is for the evidence record, not the SQL
   literal.
4. Every result row, including app when present.
5. The telemetry deploy link and deployed commit SHA.

Keep this telemetry and its bindings through the final prefixless cutover.
Remove it only after the cutover is deployed and verified; the cleanup issue for
that later work is owned by the parent migration track.
