# Workflows

Kody exposes Cloudflare Workflows through `kody:runtime` in every server-side
runtime context: `execute`, ad hoc scheduled jobs, saved package jobs, package
subscriptions, package exports, and package services.

Use workflows instead of plain `execute` for durable batch sweeps, migrations,
polling loops, retryable steps, or work that may run longer than execute's
timeout (~90s). Workflow-invoked package exports and inline workflow code get a
longer sandbox budget (~4.5 minutes, under the Cloudflare Workflow step timeout)
and run without the package-invocation idempotency ledger, so a step retry
re-executes instead of replaying a cached timeout. The initial `execute` call
should submit one `workflows.create`; inspect that workflow later with
`workflow_run_list`.

```ts
import { workflows } from 'kody:runtime'

export default async function main(input = {}) {
	return await workflows.create({
		code: 'export default async function main(p) { return { ok: true, p } }',
		params: { greeting: input.greeting ?? 'hello' },
	})
}
```

Check status from a later MCP call:

```ts
import { kody } from 'kody:runtime'

export default async function main() {
	return await kody.workflow_run_list({ limit: 10 })
}
```

`workflows.create` accepts one durable workflow request with two source shapes:

- `code`: a complete ESM module string with a default export. Kody runs it later
  through the same module loader used by `execute`.
- `exportName`: a saved-package export to invoke later. In package runtime code,
  Kody resolves `packageId` from `packageContext`. Outside a package runtime,
  pass `packageId` explicitly.

Both shapes accept:

- `runAt`: optional ISO date-time string or `Date`; defaults to now
- `idempotencyKey`: optional caller-chosen dedupe key; omitted keys create a
  fresh run
- `params`: optional JSON object passed to the workflow body

Calling `create` again with the same explicit `idempotencyKey` and matching
workflow identity for the same user returns the existing workflow instead of
starting a duplicate. Choose keys that include the logical job identity, for
example `storage-sweep:2026-05-08`. Kody enforces a finite per-user concurrent
workflow limit from the account plan (free 3, pro 50, partner 100, max 5000); if
the cap is reached, `workflows.create` returns a clear quota error.

Use `workflow_run_list` to inspect recent workflow runs and statuses.

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
