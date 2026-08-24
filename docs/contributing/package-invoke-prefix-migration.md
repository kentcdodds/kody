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
  `usersDeleting`, `pagesScanned`, a cryptographic `populationVersion`, and
  `complete`).

It returns no user rows or identifiers. A missing epoch, failed UserMeter RPC,
missing binding, in-progress account deletion, or population mismatch makes
`complete = false`; those users are never treated as zero. The population
fingerprint must remain identical from baseline through final check, so a
completed deletion or new account cannot silently change the denominator.
Immediately after production deployment, capture a baseline with
`complete = true` and all four totals at zero. Any nonzero total or population
change blocks cutover. Deploy a new epoch and capture a new complete zero
baseline; do not clear or reuse an epoch in place.

## Fixed-window query procedure

The evidence schedule is fixed before reading form outcomes. Window `n` is the
one-hour interval
`[2026-08-23T21:22:35Z + n hours, 2026-08-23T21:22:35Z + (n + 1) hours)`, for
integer `n >= 0`. Query every closed window in order. Never skip, reorder,
overlap, resize, or combine windows in response to their form results.

Run this query separately for each window against
`kody_package_invoke_specifier_events`. Replace only the two UTC timestamp
literals with that window's exact bounds, using Analytics Engine's accepted
`YYYY-MM-DD HH:MM:SS` format. This example is window `0`.

```sql
SELECT
  blob2 AS surface,
  blob1 AS form,
  COUNT() AS retained_calls,
  MAX(_sample_interval) AS max_sample_interval,
  SUM(_sample_interval) AS weighted_calls
FROM kody_package_invoke_specifier_events
WHERE timestamp >= toDateTime('2026-08-23 21:22:35')
  AND timestamp < toDateTime('2026-08-23 22:22:35')
  AND blob1 IN ('prefixless', 'kody_prefixed')
  AND blob2 IN ('execute', 'package', 'job', 'app')
GROUP BY surface, form
ORDER BY surface, form
```

The query returns one row per surface and form. Process each closed window
before moving to the next:

1. Inspect every returned row, including sampled rows. Any observed `prefixless`
   row with `retained_calls > 0` fails and restarts the entire telemetry gate.
   Deploy a new UserMeter epoch, capture a complete zero baseline, reset every
   surface's confidence accumulator, and restart fixed windows after that
   baseline.
2. For each surface, take the maximum `max_sample_interval` across its form
   rows. A window with at least one row and a maximum of `1` may contribute
   retained `kody_prefixed` liveness counts for that surface. This selection
   depends only on sampling, never on form outcome.
3. Do **not** infer zero from a missing `prefixless` row. Form is stored in
   non-indexed `blob1`; Analytics Engine may omit a rare blob subgroup even when
   returned rows have `_sample_interval = 1`. The shared constant index does not
   make this grouped query absence-capable.
4. Zero-prefixless confidence comes only from the exact UserMeter aggregate.
   Every aggregate from the production baseline through the final window check
   must use the same epoch and population version, report `complete = true`, and
   keep every surface total at zero. If any exact total or the population
   version changes, deploy a new epoch, capture a complete zero baseline, and
   restart fixed windows after that baseline. Windows before that baseline
   remain reporting-only.
5. Sampled or missing surface-windows add no confidence counts, but remain in
   the ordered evidence ledger. Sum `weighted_calls` by surface/form for
   reporting only; weighted values never enter the confidence gate.

## Cleanup gate

Remove prefixless runtime and type support only when both safety gates pass:

1. **Executable source:** fleet scan `803e3045` reports 307 clean packages, zero
   executable-source findings, zero drift, and zero errors. Its three remaining
   findings are private README-only documentation and cannot execute. They do
   not block runtime/type removal once telemetry passes.
2. **Telemetry:** an absence-capable proof source exists for every runtime
   surface. From the exact counter's complete all-zero production baseline,
   predeclared disjoint Analytics Engine windows accumulate, independently for
   `execute`, `package`, and `job`, at least 300 retained calls total and at
   least 30 retained `kody_prefixed` calls while every exact aggregate remains
   complete and zero. If `app` is active, it must independently meet the same
   liveness thresholds and exact-zero requirement.

The fixed windows are disjoint, so calls included for one surface are never
double-counted. Predeclaring every window and selecting solely on sampling and
the independently documented proof source prevents cherry-picking based on the
desired zero outcome. Once absence-capable windows accumulate 300 unsampled
calls, they support the rule-of-three target (an approximate one-sided 95% upper
bound near 1% under independent calls). Thirty observed `kody_prefixed` calls
separately prove that each surface is live. Every Analytics Engine window must
still be queried: an observed prefixless row in a sampled or unsampled window
restarts the gate.

The exact counter proves prefixless absence; Analytics Engine proves that each
surface remained live and using the canonical form. The separate minimum of 30
prefixed calls prevents a dead or miswired liveness path from looking safe.

A paged aggregate is not an atomic fleet snapshot while prefixless writes are
still enabled. Treat the last read while acceptance remains enabled as
provisional. Keep the exact UserMeter methods and epoch deployed while the
cutover removes prefixless runtime acceptance, allow old Worker isolates and
in-flight calls to drain, then run the aggregate again. That verification read
after acceptance removal must retain the same epoch and population version,
report `complete = true`, and still contain all-zero totals before the
compatibility storage or methods may be removed. Any increase means a late
deprecated call raced the cutover; restore compatibility, deploy a new epoch,
capture a new zero baseline, and restart the gate.

The three README-only findings remain aggregate owner-action documentation debt.
Track their count without publishing private package ids or owners. Keep codemod
0007 and the local prefixless teaching error available to repair those docs; do
not treat documentation debt as executable compatibility risk.

## Current evidence

The cumulative check recorded in
[issue #1702](https://github.com/kentcdodds/kody/issues/1702#issuecomment-5400279163)
covered `[2026-08-23T21:22:35Z, 2026-08-24T19:30:00Z)`:

| Surface   | Retained prefixed | Weighted prefixed | Maximum sample interval |
| --------- | ----------------: | ----------------: | ----------------------: |
| `execute` |                63 |                76 |                       2 |
| `job`     |                86 |                86 |                       1 |
| `package` |                71 |                71 |                       1 |

No prefixless or app rows were returned. This is non-qualifying historical
evidence: execute was sampled, and absence of a non-indexed form cannot be
inferred from the returned rows. Analytics Engine may choose a different read
resolution for shorter time ranges, so this result does not establish the
capacity of any fixed one-hour window. The operator must replay fixed one-hour
windows from window `0` in order, but those queries cannot complete the
zero-prefixless gate before the exact UserMeter baseline.

Attach the following evidence to the final cutover:

1. The exact-counter deployed commit, deploy link, epoch, complete zero
   baseline, and every bounded follow-up aggregate.
2. Every closed fixed window number and exact UTC bounds, in order, including
   sampled and empty surface-windows.
3. The exact supported query, every grouped result row, and per-surface retained
   and weighted liveness accumulators.
4. Prefixless reset points, dataset name, index values, telemetry deploy link,
   and deployed commit.
5. Fleet scan `803e3045` totals plus the aggregate count of README-only debt;
   never publish private package ids or owners.

Keep prefixless runtime acceptance and the exact/Analytics evidence paths
through final cutover verification. Object invocation stays removed; do not add
publish rejection or package migration. After cutover, cleanup issue #1702
removes the prefixless parser branch, exact UserMeter RPC methods/table, admin
endpoint, dedicated Analytics binding, and temporary migration guidance.
Permanent codemod `0007` and its local teaching error remain.
