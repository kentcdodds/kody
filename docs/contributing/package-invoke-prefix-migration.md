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
   Reset every surface's confidence accumulator and resume with the next fixed
   window.
2. For each surface, take the maximum `max_sample_interval` across its form
   rows. The window contributes confidence counts for that surface only when it
   returned at least one row and that maximum is `1`. This selection depends
   only on sampling, never on whether a form row is present.
3. In a qualifying unsampled surface-window, retained total is the sum of
   `retained_calls`; retained `kody_prefixed` and `prefixless` are their
   matching form rows. A missing `prefixless` row counts as zero only because
   both forms share constant `index1 = package_invoke_specifier_form_migration`
   and the surface-window is unsampled.
4. Sampled or missing surface-windows add no confidence counts, but remain in
   the ordered evidence ledger. Sum `weighted_calls` by surface/form for
   reporting only; weighted values never enter the confidence gate.

## Cleanup gate

Remove prefixless runtime and type support only when both safety gates pass:

1. **Executable source:** fleet scan `803e3045` reports 307 clean packages, zero
   executable-source findings, zero drift, and zero errors. Its three remaining
   findings are private README-only documentation and cannot execute. They do
   not block runtime/type removal once telemetry passes.
2. **Telemetry:** since the most recent prefixless observation (or from window
   `0` when none has occurred), the qualifying unsampled windows accumulate,
   independently for `execute`, `package`, and `job`, at least 300 retained
   calls total, at least 30 retained `kody_prefixed` calls, and zero retained
   `prefixless` calls. If `app` is active, it must independently meet the same
   thresholds.

The fixed windows are disjoint, so retained calls included for one surface are
never double-counted. Predeclaring every window and selecting solely on
`max_sample_interval = 1` prevents cherry-picking based on the desired zero
outcome. The accumulated 300 unsampled calls support the rule-of-three target
(an approximate one-sided 95% upper bound near 1% under independent calls).
Thirty observed `kody_prefixed` calls separately prove that each surface is
live. Every window must still be queried: a prefixless observation in a sampled
or unsampled window restarts the gate.

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

No prefixless or app rows were returned. This cumulative query demonstrates why
one unsampled 300-call window is unattainable for `execute`, but it is not
itself part of the new disjoint-window confidence ledger. The operator must
replay the fixed one-hour windows from window `0` in order.

Attach the following evidence to the final cutover:

1. Every closed fixed window number and exact UTC bounds, in order, including
   sampled and empty surface-windows.
2. The exact supported query and every grouped result row.
3. Prefixless reset points and per-surface qualifying-window accumulators.
4. Dataset name, shared index value, telemetry deploy link, and deployed commit.
5. Fleet scan `803e3045` totals plus the aggregate count of README-only debt;
   never publish private package ids or owners.

Keep this telemetry and its bindings through the final prefixless cutover.
Remove it only after the cutover is deployed and verified; the cleanup issue for
that later work is owned by the parent migration track.
