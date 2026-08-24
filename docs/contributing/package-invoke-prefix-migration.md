# `packages.invoke` prefix migration

String-first `packages.invoke` accepts both `kody:@owner/package[/export]` and
the deprecated prefixless `@owner/package[/export]` form. The parser
canonicalizes the latter to `kody:`. Object-only invocation is removed, and
publishing does not reject prefixless string-first calls.

Use permanent codemod `0007-prefix-packages-invoke-specifiers` to migrate
literal calls and parseable dynamic first arguments. Dynamic calls receive an
inline once-only normalizer that prefixes trimmed `@...` values and passes other
values to the existing runtime parser unchanged. Unparseable and
binding-ambiguous calls remain manual; there is no binding-blind textual
fallback. 0007 is intentionally separate from `0006-invoke-object-to-specifier`,
which retains responsibility for the removed object-only API.

## Evidence sources

Analytics Engine remains the weighted liveness and volume source. Every
string-first call is classified before parser canonicalization and written to
the dedicated production dataset `kody_package_invoke_specifier_events` (preview
uses `kody_package_invoke_specifier_events_preview`).

The schema is deliberately coarse:

| Field     | Value                                     |
| --------- | ----------------------------------------- |
| `index1`  | `package_invoke_specifier_form_migration` |
| `blob1`   | same form value                           |
| `blob2`   | `execute`, `package`, `job`, or `app`     |
| `double1` | `1`                                       |

No user, package, specifier, export, params, source, run, request, or
conversation identity is recorded. Recording is nonthrowing and a no-op where
the binding is absent. Both forms use the same constant `index1`; form remains
only in non-indexed `blob1`.

Attribution is deterministic: a parent job run selects `job`; otherwise an app
runtime marker selects `app`; otherwise an execute caller selects `execute`; all
remaining calls select `package`.

Analytics Engine is not absence-capable for this migration. A missing
non-indexed `blob1 = prefixless` group does not prove no such source event
existed, even when returned rows have `_sample_interval = 1`. Never claim
fixed-window prefixless absence from this dataset.

Valid deprecated prefixless calls additionally use an exact counter in the
caller's existing per-user `UserMeter` Durable Object:

- after validation and before canonicalization, the caller awaits one
  `recordPackageInvokePrefixless` RPC;
- a failed or ambiguous RPC fails the deprecated call, so no successful
  prefixless call can be uncounted;
- canonical `kody:` calls skip this path and incur no new Durable Object RPC;
- the stored row is only a deployment epoch plus `execute`, `package`, `job`,
  and `app` integer counters. The UserMeter object name is already the user
  namespace; no user id column, package/specifier/export/source/params, event
  identity, or other content is stored; and
- one RPC means one increment. The caller does not retry an ambiguous write
  because the privacy contract deliberately stores no per-call idempotency
  identity. A possible conservative overcount blocks cleanup; it cannot create
  false absence.

The current epoch is `packages-invoke-prefixless-2026-08-24-v1`. The UserMeter
schema initializes a zero row for that exact epoch when the deployed class is
reached. A reset requires changing the epoch, bumping the UserMeter schema
version, and deploying both together. Readers request only the compiled epoch,
so counters from an earlier deployment can never mix with the current gate.

## Admin exact aggregate

`GET /admin/insights/package-invoke-prefixless-evidence.json` is admin-only and
read-only. It keyset-pages all non-deleting users with stable ids, reads each
UserMeter with bounded page fan-out, and returns only:

- the exact epoch;
- global `execute`, `package`, `job`, and `app` totals; and
- population/accounting fields (`usersExpected`, `usersEnumerated`,
  `usersAttempted`, `usersLoaded`, `usersMissingEpoch`, `usersUnreachable`,
  `pagesScanned`, and `complete`).

It returns no user rows or identifiers. A missing epoch, failed UserMeter RPC,
missing binding, or population mismatch makes `complete = false`; those users
are never treated as zero. Immediately after production deployment, capture a
baseline with `complete = true` and all four totals at zero. Any nonzero total
blocks cutover. If a reset is needed, deploy a new epoch and capture a new
complete zero baseline; do not clear or reuse an epoch in place.

## Analytics Engine liveness query

Run this query against `kody_package_invoke_specifier_events`. Replace only the
two UTC timestamp literals, using Analytics Engine's accepted
`YYYY-MM-DD HH:MM:SS` format. The start must be after the telemetry deploy
completed; the end must be after the observation window closed.

```sql
SELECT
  blob2 AS surface,
  blob1 AS form,
  COUNT() AS retained_calls,
  MAX(_sample_interval) AS max_sample_interval,
  SUM(_sample_interval) AS weighted_calls
FROM kody_package_invoke_specifier_events
WHERE timestamp >= toDateTime('2026-08-01 00:00:00')
  AND timestamp < toDateTime('2026-08-08 00:00:00')
  AND blob1 IN ('prefixless', 'kody_prefixed')
  AND blob2 IN ('execute', 'package', 'job', 'app')
GROUP BY surface, form
ORDER BY surface, form
```

Analytics Engine can sample high-volume data. Each retained row represents
`_sample_interval` source events. Weighted sums report estimated workload
volume, but they are not independent observations. Only prefixed liveness rows
from predeclared disjoint windows whose returned surface rows all have
`max_sample_interval = 1` contribute retained confidence counts. Every observed
prefixless row is still a hard failure, sampled or not. Missing prefixless rows
never contribute absence evidence; only the complete exact UserMeter aggregate
does that.

The query returns one row per surface and form. Aggregate it outside Analytics
Engine for each surface:

- retained total = sum of `retained_calls` across its form rows;
- retained `kody_prefixed` / `prefixless` = each matching form row's
  `retained_calls`;
- weighted total = sum of `weighted_calls` across its form rows, with each
  form's weighted count taken from its row; and
- surface sampling interval = maximum `max_sample_interval` across its rows.

A missing required surface (`execute`, `package`, or `job`) fails the Analytics
Engine liveness gate. A missing `app` row means no observed app liveness and
does not block cleanup unless app traffic appears in another readout. Follow the
ordered fixed one-hour ledger anchored at `2026-08-23T21:22:35Z` from
[cleanup issue #1702](https://github.com/kentcdodds/kody/issues/1702). Windows
before the exact-counter production deploy remain reporting-only because the
counter did not cover them.

## Cleanup gate

Remove prefixless runtime support only when all of the following hold:

- Every exact aggregate from the post-deploy baseline through the final check
  has the same epoch, `complete = true`, and global prefixless totals of exactly
  zero for every surface.
- `execute`, `package`, and `job` each independently accumulate at least `300`
  retained calls and `30` retained `kody_prefixed` calls from ordered,
  post-exact-deploy, unsampled Analytics Engine surface-windows. Weighted values
  remain liveness/volume reporting only.
- `app` is observed in every readout. If it has any traffic, it must meet the
  same retained `300` / `30` liveness thresholds independently while its exact
  prefixless total remains zero.

Do not combine surfaces to reach a threshold. Execute, package, and job each
must pass independently.

The exact counter proves prefixless absence; Analytics Engine proves that each
surface remained live and using the canonical form. The separate minimum of 30
prefixed calls prevents a dead or miswired liveness path from looking safe.

Attach the following evidence to the final cutover:

1. The exact-counter deployed commit, deploy link, epoch, complete zero
   baseline, and every bounded follow-up aggregate.
2. Every fixed window number in order, the exact query text used, and dataset
   name `kody_package_invoke_specifier_events`.
3. Exact start and end UTC timestamps in ISO 8601 form alongside each executed
   query. The evidence timestamps correspond exactly to the UTC values passed to
   `toDateTime(...)`; ISO formatting is for the evidence record, not the SQL
   literal.
4. Every result row, including app when present.
5. Prefixless reset points and per-surface retained and weighted liveness
   accumulators.

Keep prefixless runtime acceptance and the exact/Analytics evidence paths
through final cutover verification. Object invocation stays removed; do not add
publish rejection or package migration. After cutover, cleanup issue #1702
removes the prefixless parser branch, exact UserMeter RPC methods/table, admin
endpoint, dedicated Analytics binding, and temporary migration guidance.
Permanent codemod `0007` and its local teaching error remain.
