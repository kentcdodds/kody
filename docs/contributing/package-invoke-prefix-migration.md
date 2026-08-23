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
two ISO-8601 timestamp literals with the exact start and end of the evidence
window. The start must be after the telemetry deploy completed; the end must be
after the observation window closed.

```sql
SELECT
  blob2 AS surface,
  SUM(_sample_interval) AS weighted_calls_total,
  SUM(
    CASE WHEN blob1 = 'prefixless' THEN _sample_interval ELSE 0 END
  ) AS weighted_prefixless_calls,
  SUM(
    CASE WHEN blob1 = 'kody_prefixed' THEN _sample_interval ELSE 0 END
  ) AS weighted_kody_prefixed_calls
FROM kody_package_invoke_specifier_events
WHERE timestamp >= 'START_ISO_8601'
  AND timestamp < 'END_ISO_8601'
  AND blob1 IN ('prefixless', 'kody_prefixed')
  AND blob2 IN ('execute', 'package', 'job', 'app')
GROUP BY blob2
ORDER BY blob2
```

Analytics Engine can sample high-volume data. Each retained row represents
`_sample_interval` source events, so raw `COUNT(*)` undercounts traffic. Every
total and per-form count in the retirement decision must therefore use the
weighted sums above.

## Cleanup gate

Remove prefixless runtime support only when one query window proves all of the
following:

- `execute`, `package`, and `job` each independently have exactly `0`
  `weighted_prefixless_calls`, at least `300` `weighted_calls_total`, and at
  least `30` `weighted_kody_prefixed_calls`.
- `app` is observed in every readout. If it has any traffic, it must meet the
  same `0` / `300` / `30` thresholds independently. A missing app row means no
  app traffic and does not block cleanup.

Do not combine surfaces to reach a threshold. Execute, package, and job are
historically active and each must pass independently.

The zero-in-300 threshold is the rule of three: with zero observed prefixless
calls in 300 weighted calls, the approximate one-sided 95% upper confidence
bound on the prefixless rate is `3 / 300`, or about 1%. The independent minimum
of 30 weighted `kody_prefixed` calls prevents a dead or miswired telemetry path
from looking safe merely because it reported zero deprecated calls.

Attach the following evidence to the final cutover:

1. The exact query text used, unchanged except for its timestamp literals.
2. Dataset name `kody_package_invoke_specifier_events`.
3. Exact start and end timestamps.
4. Every result row, including app when present.
5. The telemetry deploy link and deployed commit SHA.

Keep this telemetry and its bindings through the final prefixless cutover.
Remove it only after the cutover is deployed and verified; the cleanup issue for
that later work is owned by the parent migration track.
