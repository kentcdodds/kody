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
TypeScript rows run in Node with `import { kody } from 'kody:runtime'`. Neither
row is the production Dynamic Worker. Use them to compare source size and task
success. Use preview for Pyodide cold start.

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
