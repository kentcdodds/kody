# 0011: Workers-unit keeps per-file isolation; budget cold DO load in timeouts

- **Status:** accepted
- **Date:** 2026-08-07

## Context

`@cloudflare/vitest-pool-workers` charges roughly 10–18s to load Durable Object
classes (Mailbox, UserMeter, RunLog) through the Vitest module runner. Warm RPCs
are ~1ms; production is ~0.4ms. That cold load sat inside `testTimeout`, so a 5s
local default failed pre-push while `CI=1` (20s) stayed green and agents reached
for `--no-verify`.

Alternatives considered:

- Warm in `globalSetup` — runs in Node; cannot touch workerd bindings.
- Warm in workers-unit `setupFiles` via `runInDurableObject` or stub RPCs —
  moves cost out of test bodies, but breaks webhook routing, scheduled-lane,
  subscription-dispatch, and `package_save` workers suites (measured: 9 failures
  that pass when the warmup is removed).
- `--maxWorkers=1 --no-isolate` to pay once for the whole run — much faster wall
  clock, but shared D1/KV/DO storage breaks suites that assume per-file
  isolation (~50 failures on a full workers-unit run).
- Stubbing DOs in node tests when the point is binding fidelity — drops the
  thing under test.

## Decision

Keep per-file storage isolation and parallel workers-unit. Do **not** warm
Durable Objects from `globalSetup` or workers-unit `setupFiles`. Prefer
`*.node.test.ts` unless real Cloudflare bindings or Workers-only APIs are
required. Keep a shared Vitest `testTimeout` of 20s (and `CI=1` on `test:push` /
validate’s test and e2e legs) so the pool’s per-file DO cold load does not fail
the default budget.

## Consequences

- First DO RPC in a workers-unit file can still take ~10s; suites that need more
  headroom keep an explicit per-test timeout.
- Agents must not “fix” pool slowness with `--no-isolate`, `setupFiles` /
  `globalSetup` DO warmups, `--no-verify`, or a shorter local `testTimeout`.
- Misclassified `*.workers.test.ts` files that never need bindings or
  Workers-only APIs should become `*.node.test.ts`.
- Revisit if Cloudflare’s pool loads DO classes cheaply (for example Vite
  bundled-dev), or if a warmup approach is proven not to disturb export wrapping
  / storage isolation.
