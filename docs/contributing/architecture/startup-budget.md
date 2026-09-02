# Worker startup budget

Cloudflare validates every Worker upload against a fixed startup CPU limit: the
time spent evaluating the main module (parse, compile, and every top-level
statement) must stay under the platform ceiling or the upload is rejected with
`Script startup exceeded CPU time limit`. The check runs on Cloudflare's
validation hosts, so a script that sits near the ceiling passes on one upload
and fails on the next. That is what preview deploys did before this budget
existed.

This document records what counts toward startup, how to measure it, the rules
that keep it low, and the CI tripwire that stops regressions.

## What counts

Module evaluation of the startup entry
(`packages/worker/src/production-worker.ts`, `platform-worker.ts`,
`runtime-worker.ts`) and everything it imports statically. In this codebase the
expensive items were, in order:

- Zod schema construction at module scope. Every capability definition builds
  its input and output schemas when its module evaluates; the MCP server SDK
  builds wire schemas for each protocol revision the same way.
- Third-party libraries with large top-level tables: `isomorphic-git`,
  `@babel/parser`, `tldts`, `marked`.
- Anything that touches ICU at module scope (`new Intl.NumberFormat(...)`).
- Statically imported WebAssembly modules (compiled at load).

Request-time work is not part of the budget. Cloudflare only measures module
evaluation, so moving work to first use is a real fix, not a shuffle.

## Measuring

Profile a worker with Wrangler's built-in startup profiler from the package
directory that owns its config:

```bash
cd packages/worker && npx wrangler check startup --env production --args ./src/production-worker.ts
cd packages/platform-worker && npx wrangler check startup
cd packages/runtime-worker && npx wrangler check startup
```

The summary prints `Active: N ms` (sampled CPU during evaluation, including
garbage collection) and writes a `.cpuprofile` that Chrome DevTools or VS Code
can open as a flamegraph. Absolute numbers are machine-specific; compare before
and after on the same machine.

To attribute time to source files, build the same entry with
`wrangler deploy --dry-run --outdir <dir>` and map profile frames through the
emitted source map. A frame with no ancestor in `packages/` is third-party
module initialisation hoisted to the bundle's top level; walk to the nearest
non-library caller to find which of our modules imported it.

## Rules

1. **Capability domains load lazily.**
   `packages/worker/src/mcp/capabilities/builtin-domains.ts` loads each
   `{domain}/domain.ts` through dynamic `import()` and `getStaticRegistry()` is
   async. esbuild keeps the code in the same bundle but wraps those modules so
   they evaluate on the first request that needs the registry. Never import a
   `*/domain.ts` or a capability definition module statically from anything on
   the startup path; one static edge makes esbuild evaluate the module eagerly
   again. Shared helpers (`{domain}/shared.ts`) are the supported static entry
   points, so keep them light: helpers, not schema catalogs.
2. **Heavy libraries load on first use.** `isomorphic-git` goes through
   `packages/worker/src/repo/isomorphic-git-lazy.ts`; the MCP server SDK goes
   through `loadMcpServerModule()` in
   `packages/worker/src/mcp/protocol-metrics.ts` and the lazy stateless-lane /
   legacy-lane loaders in `mcp-auth.ts` and `origin-handler.ts`. The platform
   worker is the exception: the `MCP` Durable Object class extends the agents
   SDK base class at module scope, so that worker carries the SDK cost by
   design.
3. **No module-scope formatters or wasm on the startup path.** Build `Intl.*`
   objects on first use (see `universal/dynamic-worker-cost.ts`). Keep
   WebAssembly imports inside modules that are only reached lazily.
4. **New capability schemas belong in capability files**, which are lazy, not in
   modules the app handlers import.

## CI tripwire

`npm run worker-startup-time:check` (`tools/check-worker-startup-time.ts`, part
of `npm run validate` and the CI static job) profiles each production entry
three times with `wrangler check startup` and compares the best sample to
`tools/worker-startup-budget.json`. Budgets sit well above the steady-state
reading and well below the level that made uploads flaky, so the check catches a
re-eagerised domain graph or a new heavy import without failing on runner noise.
It complements `worker-startup-bundles:check`, which bounds bytes and
import-graph boundaries deterministically.

When a change buys headroom, lower the budget in the same PR. Raise a budget
only with a written justification in the PR description.

## Reference readings

Best-of-three readings from the deferral work that introduced this budget. The
GitHub-hosted runner reads roughly 1.6× the local development VM, and the
budgets are set against the runner (about 1.5× its steady reading), so a local
run has more headroom than CI does.

| Worker   | Local before | Local after | CI after | Budget |
| -------- | ------------ | ----------- | -------- | ------ |
| origin   | 309 ms       | 110 ms      | 186 ms   | 280 ms |
| platform | 160 ms       | 166 ms      | 228 ms   | 340 ms |
| runtime  | 199 ms       | 70 ms       | 102 ms   | 160 ms |

For scale: before the deferrals the origin entry would have read roughly 500 ms
on the runner, which is the regime in which Cloudflare uploads failed
intermittently.
