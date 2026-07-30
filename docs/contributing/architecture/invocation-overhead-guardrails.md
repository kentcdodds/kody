# Invocation overhead guardrails

The static-first package model rests on a performance claim: static
`kody:@scope/pkg/export` imports cost nothing at invocation time, and keyless
`packages.invoke` stays lean enough (tens of milliseconds of platform overhead)
that agents never route around the contract-checked path. This document records
the guardrails that keep that claim true. It is about platform overhead per
call, not about what user code does inside the call.

## Per-call overhead budgets

- **Static imports** add zero platform cost at invocation time by construction:
  no dispatch, no contract check, no bookkeeping per call. Their costs are paid
  when the caller is bundled — at publish time for packages (typecheck, repo
  checks, artifact rebuild), and inside the per-call bundle step that ad hoc
  execute already pays regardless of imports. Do not add per-call bookkeeping to
  the static import path.
- **Keyless `packages.invoke`** is the lean/ephemeral mode: contract check plus
  dispatch into the target package's own runtime, no idempotency ledger row, run
  records on-failure-only. Its hot path budget is **tens of milliseconds** of
  platform overhead per call. Work that would push it beyond that (extra D1
  round trips, eager run-record writes, synchronous vector or KV lookups)
  belongs in the keyed mode or off the hot path (`waitUntil`).
- **Keyed `packages.invoke`** deliberately pays for durability: a ledger claim,
  eager run records, and a bounded response snapshot for replay. That cost is
  the feature; it must never silently leak into the keyless mode.

## Watch the percentiles

Every invocation surface is metered through `recordUsage()` (see
[Usage metering](./usage-metering.md)); events land in the `kody_usage_events`
Analytics Engine dataset with per-surface `eventType` values. The mapping that
matters here: keyless `packages.invoke` target runs are saved-package bundled
runs, so they land under the `package_export` event type (`entityId` = package
id), while the calling surface reports its own event type (`execute`, `job_run`,
`workflow_run`, `service_runtime`). When touching an invocation path, watch the
`durationMs` percentiles (p50/p95/p99) of the affected event types before and
after the change rather than reasoning from a single local timing. A regression
in the `package_export` or `execute` percentiles is a release blocker for the
change that caused it, not a follow-up.

## New awaited D1 writes need a budget justification

Any change that adds an **awaited D1 write** to a hot invocation path (ad hoc
execute, keyless `packages.invoke`, package export runs, subscription dispatch,
retriever calls) must include an explicit budget justification in its PR
description: what the write costs at p95, why it cannot be deferred with
`waitUntil`, batched, or moved to the keyed/durable mode, and which surface
percentile it is expected to move. Reviewers should treat an unexplained new
awaited write on these paths as a defect.

Failure-path writes (error run records) and keyed-mode writes (ledger claim,
eager run records) are already part of their respective budgets and do not need
per-PR justification.
