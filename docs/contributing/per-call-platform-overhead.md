# Per-call platform overhead budgets

Kody's agent surface encourages composition: discover a package or capability,
then call it from `execute`. That composition only stays cheap if the **default
call pattern** avoids nested platform work. This document captures the
measurement, the preferred pattern, and the guardrails that keep per-call
overhead bounded as the platform opens to many more users.

## Measured cost (static import vs dynamic invoke)

Live production probes on heykody.dev (Jul 2026, after
[#1035](https://github.com/kentcdodds/kody/pull/1035) removed double loads, a
nested write lease, and awaited run-record writes) and Analytics Engine
`kody_usage_events` for the current UTC month show:

| Path | In-sandbox wall time (trivial `github/accounts` export) | Notes |
| --- | --- | --- |
| Static `import … from "kody:@scope/pkg/export"` | ~0 ms per call after bundling | Same sandbox as the outer `execute`; no nested export run |
| `packages.invoke` | ~650–1100 ms | Nested package-export run + idempotency D1 |
| `packages.invokeChecked` | ~580–700 ms warm | Same nested path; check phase reuses preloads after #1035 |

Month-to-date Analytics Engine (success only, weight `_sample_interval`):

| `eventType` | Samples | Avg `durationMs` | Share ≥ 700 ms |
| --- | ---: | ---: | ---: |
| `execute` | ~60k | ~2.5 s | mixed (includes user work) |
| `package_export` | ~9.5k | ~4.3 s | ~75% ≥ 700 ms; almost none under 50 ms |

`package_export` is the nested bundled run created by dynamic package
invocation (and by jobs/subscriptions/HTTP invocations). Static imports do
**not** emit a nested `package_export` for the imported helper call.

Outer `execute` responses expose Server-Timing-style phases under
`structuredContent.timing.serverTiming` (`bundle`, `hydrate`,
`provider-assembly`, `sandbox`, `run`, plus optional typecheck phases). Use
those phases when attributing outer-execute cost; nested invoke overhead sits
inside the outer `sandbox` phase today.

## Why dynamic invocation was the original default

The ~600–1000 ms is not accidental waste; it buys guarantees that static
imports do not provide. `invokeChecked` was blessed because it is the path
that **always works and always upholds the platform's contracts**:

- **Freshness** — resolves the target's current published artifact at call
  time. (For *ad hoc execute*, static imports are bundled per call, so they
  also see the current published version; the staleness concern is real for
  *package-to-package* static deps, which freeze until the dependent
  republishes.)
- **Isolation / trust boundary** — the target runs in its own runtime with its
  own grants. Static imports pull the target's code into the caller's sandbox,
  and storage grants are **per-bundle**: importing a package grants the whole
  bundle read/write on that package's bucket. For unadopted community-fork
  code this is a materially wider trust surface.
- **Package runtime context** — `packageSecrets` mounts, `packageContext`,
  nested `packages`, and package-mediated storage exist only in the package's
  own runtime. Post-approval secret smoke tests **must** use `invokeChecked`;
  a static import cannot verify secret mounts.
- **Idempotent dedup** — the `package_invocations` row dedupes domain events
  (webhook redelivery, retried dispatch). Static composition has no replay
  protection beyond the outer execute's optional key.
- **Observability** — each dynamic call produces a `package_export` run record
  and usage event (Activity, `runs` domain, per-package cost attribution).
  Static composition attributes everything to the caller's execute.

The old guidance chose the universally-correct-but-slow default. The flip
re-scopes it: for **library-like reuse of trusted packages from execute** —
the dominant agent pattern — none of those guarantees are needed, so paying
~1s per call for them is waste. The guarantees stay blessed where they matter.

## What the flip costs (accepted trade-offs)

- **Thinner per-package observability**: statically composed calls emit no
  `package_export` events, so that metric's population shifts toward the
  genuinely dynamic surfaces (watch the volume ratio, not just percentiles).
- **Trust responsibility moves to guidance**: static-first copy must keep the
  "trust decision" caveat loud; unadopted community forks belong behind
  `invokeChecked` isolation.
- **Staleness footguns for package authors**: packages that statically import
  other packages keep snapshots until republished. Event fan-out and
  dispatcher packages must stay on dynamic invocation.

## When dynamic invocation is genuinely required

Prefer static `kody:@scope/package/export` imports unless one of these applies:

1. **Fresh-version semantics** — the caller must observe the target's latest
   published export without republishing the caller (event fan-out,
   dispatchers, workflow bridges).
2. **Target package runtime** — the export needs `packageContext`,
   `packageSecrets`, the nested `packages` helper, or other package-only
   bindings that a static import into ad hoc execute does not provide.
   Post-approval secret smoke tests are always this case.
3. **Cross-package storage mediation** — the caller wants the *other* package's
   runtime to mediate reads/writes rather than trusting bundler provenance
   grants from a static import.
4. **Isolation for less-trusted code** — unadopted community forks should run
   in their own runtime, not inside the caller's bundle.
5. **Domain-event dedup** — the invocation needs an idempotency row keyed by a
   domain event id.

Literal `await import("kody:@scope/package/export")` is a middle ground: it
resolves the current published artifact at runtime inside the caller's run
(no `package_invocations` row, no nested export run record) but still is not
the default for ordinary reuse.

## Preferred agent pattern

1. `search` → inspect entity detail → **static import** the export into
   `execute` (or into another package).
2. Use `packages.invokeChecked` only for the edge cases above.
3. Smoke-test after save/publish with a static import when enough; use
   `invokeChecked` when the smoke test needs the package runtime.

MCP server instructions, the execute tool description, search package entity
detail (`## Import vs invoke`), and usage docs follow this order.

## Remaining warm `invokeChecked` hops

Even after #1035, a warm dynamic invoke still pays sequential work:

- D1 saved-package resolve (kind-aware lookup preferred)
- D1 entity-source row — **deliberately uncached**: its `published_commit` is
  how every downstream cache observes republishes; caching it would delay the
  freshness contract dynamic invocation exists to provide
- Published bundle artifact D1 row + KV payload (KV payload isolate-cached by
  kvKey, which embeds the published commit; the D1 identity row stays
  authoritative and uncached)
- Account write lease (re-entrant when already held)
- Idempotency claim — `INSERT OR IGNORE` first **only** when the key is a
  fresh auto-generated UUID (execute-origin, replay impossible);
  caller-supplied and deterministic keys stay lookup-first because replays are
  expected there and a read is cheaper than an ignored write attempt
- Nested RunLog begin/finish (scheduled via `waitUntil` when available)
- Nested LOADER evaluate + provider assembly
- Package-export usage metering (scheduled via `waitUntil` when available)

Safe cheapening targets **duplicate reads** and **response-path awaits** only.
Reads whose freshness carries a contract (source rows) and writes that carry
replay semantics (idempotency rows for domain events) are not fair game.

## Systemic recommendation: keep overhead bounded as users grow

Every new per-call D1 write or Durable Object round trip is multiplied by
`users × calls`. Treat that product as the budget unit, not the single-call
latency alone.

### Per-call D1 budgets for hot paths

| Surface | Hot-path budget (warm, success) | Notes |
| --- | --- | --- |
| Ad hoc `execute` (no keyed idempotency) | Prefer **≤ 2** awaited D1 writes on the response path | Quota counter upsert is the main write; plan lookups should stay cached |
| Static `kody:@` composition inside execute | **0** nested `package_invocations` / nested export run records | Bundler provenance covers `packageStorage()` |
| `packages.invoke*` | **≤ 2** D1 writes for idempotency (claim + terminal) on the fresh-key path; reads should hit isolate caches after the first warm call | Do not add per-call analytics or popularity upserts on the response path |
| Nested package export run records | Begin/finish via `waitUntil` when the MCP DO can extend lifetime | Never block the agent response on observability |

Add a new awaited D1 read/write to these paths only with an explicit budget
note in the PR (how many new round trips, which cache absorbs warm repeats,
and the expected `users × calls` multiplier).

### Observability guardrails

Watch Cloudflare Analytics Engine dataset `kody_usage_events` (production
account) with weight `_sample_interval`:

- **`package_export` average and high-latency share** — rising avg or a growing
  fraction ≥ 700 ms after a deploy is a signal that agent guidance or hot-path
  code regressed toward dynamic invocation or added sequential work.
- **`execute` vs `package_export` volume ratio** — a surge in `package_export`
  relative to `execute` often means agents (or new instructions) are using
  `invokeChecked` as the default again.
- **Per-surface percentiles** — keep using execute `timing.serverTiming` for
  outer phases; attribute nested overhead with targeted probes when
  `package_export` moves.

Query recipe (month-to-date, success only):

```sql
SELECT
  blob2 AS metric,
  sum(_sample_interval) AS event_count,
  sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_ms,
  sum(if(double1 >= 700, _sample_interval, 0)) AS at_least_700ms
FROM kody_usage_events
WHERE timestamp >= toDateTime('<monthStart>')
  AND timestamp < toDateTime('<nextMonthStart>')
  AND blob2 IN ('execute', 'package_export')
  AND blob4 = 'success'
GROUP BY blob2
FORMAT JSON
```

### How to prevent overhead creep

1. **Guidance first** — default examples in MCP instructions, tool
   descriptions, search snippets, and package READMEs must show static imports.
   Dynamic invoke examples belong under “when you need …”.
2. **No new response-path D1 writes** on execute/invoke without a budget note
   and a `waitUntil` escape hatch when the write is observability-only.
3. **Cache with published-commit or short TTL identity** — warm repeats should
   not re-read the same source row, manifest, or artifact from D1/KV in one
   isolate lifetime.
4. **Prefer composition in one sandbox** — one `execute` that statically
   imports several helpers beats N nested `invokeChecked` calls.
5. **Review agent-facing copy in the same PR as hot-path changes** — otherwise
   optimized invoke paths stay unused while agents keep paying the expensive
   default.

## Related

- [Usage metering](./architecture/usage-metering.md)
- [Packages and manifests](./packages-and-manifests.md)
- [Execute (usage)](../use/execute.md)
- [Packages (usage)](../use/packages.md)
