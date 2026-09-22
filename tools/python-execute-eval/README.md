# Python execute experiment harness

Reference solutions for the Python vs TypeScript bakeoff. The suite grades
success, wall-clock latency, CPU when CPython reports it, generated-code size,
and a failure taxonomy (`syntax`, `runtime`, `capability_misuse`, `missing_lib`,
`contract`). Reference runs record `retries: 0`. An agent bakeoff increments
retries each time it sends a new module for the same task.

```bash
npm run eval:python-execute
```

Python rows use local CPython (`tools/python-execute-eval/sandbox-harness.py`).
TypeScript rows run in Node with `import { kody } from 'kody:runtime'`. Those
rows compare source size and task success for reference solutions. They are not
agent-written code, and they are not Dynamic Worker startup.

## Dynamic Worker cold start vs warm reuse

Cloudflare documents that Dynamic Workers can run Python, and that Python
Workers start much more slowly than JavaScript Workers. Their guidance for
one-off AI-generated code is to prefer JavaScript. Kody `execute` is that path:
a new module graph gets a new Worker Loader id, and the same graph reuses that
id for the rest of the UTC day when args stay in `params`.

```bash
npm run eval:python-execute:latency
```

The script starts a local wrangler parent, then times `LOADER.get` plus
`evaluate` for a fresh id (cold) and a second call on that same id (warm).
`processColdMs` is the first isolate of that scenario in the wrangler process.
`medianNewIdColdMs` is later fresh ids. A new agent snippet is a new id.

Local wrangler on 2026-09-22 (5 rounds, every sample checked out):

| Scenario                             | Process cold | Median new-id cold | Median warm |
| ------------------------------------ | -----------: | -----------------: | ----------: |
| javascript-minimal                   |          5ms |                4ms |         0ms |
| python-minimal                       |       1604ms |             1382ms |         1ms |
| javascript-host-call                 |          7ms |                3ms |         0ms |
| python-bridge (`kody.call` loopback) |       1389ms |             1371ms |         7ms |

Python new-id cold is about 1.4s. JavaScript new-id cold is a few milliseconds.
Warm reuse is about the same once the isolate exists. The char savings in the
reference suite (1696 vs 2800) do not pay for a cold Python isolate. Warm reuse
pays only when the module graph stays put.

## Preview (Python on the Worker Loader)

1. The caller opts in at `/account/experiments`.
2. An operator enables `python-execute` for audience `experiments_opt_in`
   (`/admin/feature-flags` or `adminFeatureFlagSet`).
3. MCP `execute` with `language: "python"` and a module that defines
   `async def main(params)` or `def main(params)`. Capabilities are
   `await kody.call(name, args)`. The isolate calls the host through
   `PythonCapabilityBridge` (a loopback WorkerEntrypoint on the script that runs
   MCP execute). Omit `language` for TypeScript.
4. `pythonPackageInvoke` accepts an in-memory manifest
   `{ name, language: "python", exports: { summarize: "<module>" } }` and an
   `export` name. Saved-package publish, search ranking, jobs, and entitlements
   stay on TypeScript packages.

The flag is off by default. TypeScript execute is unchanged when `language` is
omitted.

## Model matrix

Run the same task files with each model, writing fresh solution files and
keeping `tasks.json` goldens:

- Grok 4.7
- Claude Opus
- Claude Sonnet
- GPT-5.x

Record one row per model, language, and task using the report fields above.
