# 0011: Workers-unit keeps per-file isolation; warm DOs in setupFiles

- **Status:** accepted
- **Date:** 2026-08-07

## Context

`@cloudflare/vitest-pool-workers` charges roughly 10–18s to load Durable Object
classes (Mailbox, UserMeter, RunLog) through the Vitest module runner. Warm RPCs
are ~1ms; production is ~0.4ms. That cold load sat inside `testTimeout`, so a 5s
local default failed pre-push while `CI=1` (20s) stayed green and agents reached
for `--no-verify`.

Alternatives considered: warm in `globalSetup` (runs in Node — cannot touch
workerd bindings); `--maxWorkers=1 --no-isolate` to pay once for the whole run
(much faster wall clock, but shared D1/KV/DO storage breaks suites that assume
per-file isolation — measured ~50 failures on a full workers-unit run); lowering
fidelity by stubbing DOs in node tests when the point is binding behavior.

## Decision

Keep per-file storage isolation and parallel workers-unit. Warm Mailbox,
UserMeter, and RunLog once per Worker module cache via workers-unit `setupFiles`
(`packages/worker/src/test-support/workers-do-warmup.ts`). Prefer
`*.node.test.ts` whenever real bindings are not required. Do not disable
isolation to chase suite wall clock; do not warm Durable Objects from
`globalSetup`.

## Consequences

- Test bodies see ~1–10ms first DO RPCs; the cold load moves into setup
  (`hookTimeout` 60s on workers-unit). Suite wall clock stays similar.
- Shared `testTimeout` is 20s for remaining workerd-only work (for example
  `@cloudflare/worker-bundler`) and contended validate runs; `test:push` and
  validate’s test/e2e legs set `CI=1`.
- Agents must not “fix” pool slowness with `--no-isolate`, `globalSetup`
  warmups, or blanket DO stubs. Misclassified `*.workers.test.ts` files that
  never read bindings should become `*.node.test.ts`.
- Revisit if Cloudflare’s pool loads DO classes cheaply (for example Vite
  bundled-dev), or if the suite is deliberately redesigned for shared storage.
