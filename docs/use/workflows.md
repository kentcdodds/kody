# Workflows

Kody exposes Cloudflare Workflows through `kody:runtime` in every server-side
runtime context: `execute`, package jobs, package subscriptions, package
exports, and package apps.

Use workflows instead of plain `execute` for durable batch sweeps, migrations,
polling loops, retryable steps, or work that may run longer than execute's
timeout (~90s). Workflow-invoked package exports and inline workflow code get a
longer sandbox budget (5 minutes, the same background budget jobs get, under the
6-minute Cloudflare Workflow step timeout) and run without the
package-invocation idempotency ledger, so a step retry re-executes instead of
replaying a cached timeout. Each outbound `fetch` has a 5-minute total deadline
(the same on every surface), from request start to the end of the response body,
so a single slow upstream, such as a streamed AI-provider response that runs
past a minute, can finish inside a workflow. A response body that sends no bytes
for 60s is aborted; one that keeps streaming runs until the deadline or the
sandbox budget, whichever comes first. The initial `execute` call should submit
one `workflows.create`; inspect that workflow later with `workflowRunList`, or
cancel it with `workflowRunCancel`. Check-heavy admin steps such as fleet apply,
dry-run, and revert take one page per workflow sandbox; when `nextCursor` is
set, create another workflow with that `runId` and cursor instead of looping in
the same run.

```ts
import { workflows } from 'kody:runtime'

export default async function main(params) {
	return await workflows.create({
		code: 'export default async function main(p) { return { ok: true, p } }',
		params: { greeting: params.greeting ?? 'hello' },
	})
}
```

### Start a workflow and check back

This is the pattern for any call too long for one MCP `execute`. Start the
workflow, keep the returned `id`, and end the call. In a later `execute`, read
the run by that id:

```ts
import { kody } from 'kody:runtime'

export default async function main(params) {
	const { runs } = await kody.runList({
		workflow_id: params.id,
		error_triage: 'all',
	})
	const run = runs[0]
	if (!run) return { status: 'not started' }
	return {
		status: run.status,
		result: run.metadata.result,
		error: run.error_message,
	}
}
```

The run appears once the workflow step starts (an empty list means it is still
queued or waiting for `runAt`). Each step attempt is its own run, newest first,
so a failed attempt that is being retried shows up as an older `error` row. The
newest run's `status` is `running`, `success`, or `error`. A successful run
keeps the workflow's return value in `metadata.result`, capped at 4 KiB (larger
values are stored as a truncated `{ __truncated__: true, preview }`). Console
output lands in the run's logs; use `runGet({ run_id })` with the run's `id` to
read them. Return a small summary from the workflow and write bulky output to
storage. `workflowRunList` shows the workflow-level status (`queued`, `running`,
`complete`, …) without the result.

`workflows.create` accepts one durable workflow request with two source shapes:

- `code`: a complete ESM module string with a default export. Kody runs it later
  through the same module loader used by `execute`, including static `kody:@`
  imports and `import(specifier)` when the package name is data.
- `exportName`: a saved-package export to invoke later. In package runtime code,
  Kody resolves `packageId` from `packageContext`. Outside a package runtime,
  pass `packageId` explicitly.

Both shapes accept:

- `workflowName`: optional display name. When omitted, inline workflows fall
  back to `inline-code` and package workflows fall back to the export path. On
  `/@<slug>/-/workflows` and Activity, a displayed `inline-code` name shows the
  idempotency key as a subtitle so those runs stay distinguishable.
- `runAt`: optional ISO date-time string or `Date`; defaults to now
- `idempotencyKey`: optional caller-chosen dedupe key; omitted keys create a
  fresh run
- `params`: optional JSON object passed to the workflow body

Calling `create` again with the same explicit `idempotencyKey` and matching
workflow identity for the same user returns the existing workflow instead of
starting a duplicate. Choose keys that include the logical job identity, for
example `storage-sweep:2026-05-08`. Kody enforces a finite per-user concurrent
workflow limit from the account plan (see
[Plans and pricing](https://kody.codes/pricing)); if the cap is reached,
`workflows.create` returns a clear quota error.

Use `workflowRunList` to inspect recent workflow runs and statuses, and
`workflowRunCancel` to stop a run by id.

## Cancelling workflow runs

`workflowRunCancel({ id })` cancels one workflow run by id. Run ids look like
`dynwf-…` for inline runs and `pkgwf-…` for package runs; get them from
`workflows.create` output or `workflowRunList`. The call terminates the
underlying Cloudflare Workflow instance and marks the run `cancelled` in
`workflowRunList`.

You can only cancel your own runs. Unknown ids or another user's id return a
"not found" error.

Cancelling an already-finished run (`complete`, `errored`, `terminated`, or
`cancelled`) is a safe no-op: the response has `cancelled: false` and
`already_terminal: true` with the run's terminal status. Cancelling is
idempotent. If the run finishes in the moment you cancel it, the cancel reports
the run's actual terminal status instead of pretending it was cancelled. In rare
races a cancelled run can instead surface as `terminated` (the engine's own
terminal status) — treat `cancelled` and `terminated` both as "the run was
stopped".

A cancelled run keeps single-flighting its idempotency key, exactly like a
`complete` or `errored` run — calling `workflows.create` again with the same key
returns the cancelled run instead of starting a new one. To genuinely re-run,
pick a new idempotency key. This prevents a cancelled self-rescheduling chain
from being accidentally revived by a retry that reuses old keys.

Cancelling one run does not un-schedule runs it already created. Each queued run
is an independent workflow instance — use `workflowRunList` to find every queued
run in the chain and cancel each one by id. A run that is mid-execution may
still create its successor before termination lands, so list again after
cancelling to catch stragglers.

```ts
import { kody } from 'kody:runtime'

export default async function main() {
	return await kody.workflowRunCancel({ id: 'dynwf-abc123' })
}
```

## Package export example

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		packageId: 'pkg_123',
		exportName: './workflow-run-event',
		runAt: new Date(Date.now() + 60_000).toISOString(),
		idempotencyKey: 'sync-account-123',
		params: { accountId: 'account-123' },
	})
}
```

Saved package jobs and subscriptions call the same `workflows.create` helper.
Workflow entrypoints are not declared under `kody.workflows`; the hub resolves
any package export by name at runtime, so calling
`workflows.create({ exportName: './workflow-run-event' })` from a package
runtime context is enough.
