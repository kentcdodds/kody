# `packages.invoke` prefix migration

String-first `packages.invoke` accepts both `kody:@owner/package[/export]` and
the deprecated prefixless `@owner/package[/export]` form during this migration
phase. The parser canonicalizes the latter to `kody:`. Object-only invocation
remains removed, and publishing does not reject prefixless string-first calls.

Use permanent codemod `0007-prefix-packages-invoke-specifiers` to migrate
literal calls and parseable dynamic first arguments. Dynamic calls receive an
inline once-only normalizer that prefixes trimmed `@...` values and passes other
values to the existing runtime parser unchanged. Unparseable and
binding-ambiguous calls remain manual; there is no binding-blind textual
fallback. 0007 is intentionally separate from `0006-invoke-object-to-specifier`,
which retains responsibility for the removed object-only API.

## Privacy-safe telemetry

Every string-first call is classified before parser canonicalization and written
to the dedicated production Analytics Engine dataset
`kody_package_invoke_specifier_events` (preview uses
`kody_package_invoke_specifier_events_preview`).

The schema is deliberately coarse:

| Field     | Value                                     |
| --------- | ----------------------------------------- |
| `index1`  | `package_invoke_specifier_form_migration` |
| `blob1`   | same form value                           |
| `blob2`   | `execute`, `package`, `job`, or `app`     |
| `double1` | `1`                                       |

No user, package, specifier, export, params, source, run, request, or
conversation identity is recorded. Recording is nonthrowing and a no-op where
the binding is absent. Both forms use the same constant `index1`, so they share
one Analytics Engine sampling population; form remains only in `blob1`.

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
  COUNT(*) AS retained_calls_total,
  SUM(CASE WHEN blob1 = 'prefixless' THEN 1 ELSE 0 END)
    AS retained_prefixless_calls,
  SUM(CASE WHEN blob1 = 'kody_prefixed' THEN 1 ELSE 0 END)
    AS retained_kody_prefixed_calls,
  MAX(_sample_interval) AS max_sample_interval,
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
`_sample_interval` source events. The weighted sums report estimated workload
volume, but they are not independent observations. Retirement evidence is valid
only when `max_sample_interval = 1`, meaning the entire evidence window is
unsampled. If any sampling occurs, the gate stays closed and the operator must
collect a different unsampled window or use a separate unsampled evidence
source.

## Cleanup gate

Remove prefixless runtime support only when one query window proves all of the
following:

- `execute`, `package`, and `job` each independently have exactly `0`
  `retained_prefixless_calls`, at least `300` `retained_calls_total`, at least
  `30` `retained_kody_prefixed_calls`, and `max_sample_interval = 1`. The
  required weighted thresholds remain the same: exactly `0`
  `weighted_prefixless_calls`, at least `300` `weighted_calls_total`, and at
  least `30` `weighted_kody_prefixed_calls`.
- `app` is observed in every readout. If it has any traffic, it must meet the
  same unsampled retained and weighted `0` / `300` / `30` thresholds
  independently. A missing app row means no app traffic and does not block
  cleanup.

Do not combine surfaces to reach a threshold. Execute, package, and job are
historically active and each must pass independently.

The unsampled-only requirement makes each retained row one observed call rather
than an expanded estimate. Zero deprecated calls among at least 300 observed
calls is the rule-of-three coverage target (an approximate one-sided 95% upper
bound near 1% under independent calls). Because both forms share one Analytics
Engine sampling population and the gate requires `max_sample_interval = 1`,
those retained calls are not separately sampled by form. The separate minimum of
30 observed `kody_prefixed` calls prevents a dead or miswired telemetry path
from looking safe merely because it reported zero deprecated calls. Weighted
sums stay in the evidence as volume reporting and equal retained counts when
`max_sample_interval = 1`; they never substitute for unsampled observations.

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
