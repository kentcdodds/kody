# Workflows

Kody exposes Cloudflare Workflows through `kody:runtime` in every server-side
runtime context: `execute`, ad hoc scheduled jobs, saved package jobs, package
subscriptions, package exports, and package services.

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		runAt: new Date(Date.now() + 60_000).toISOString(),
		idempotencyKey: `execute-smoke-${Date.now()}`,
		code: 'export default async function main(p) { return { ok: true, p } }',
		params: { greeting: 'hello' },
	})
}
```

`workflows.create` accepts one durable workflow request with two source shapes:

- `code`: a complete ESM module string with a default export. Kody runs it later
  through the same module loader used by `execute`.
- `exportName`: a saved-package export to invoke later. In package runtime code,
  Kody resolves `packageId` from `packageContext`. Outside a package runtime,
  pass `packageId` explicitly.

Both shapes require:

- `runAt`: ISO date-time string or `Date`
- `idempotencyKey`: caller-chosen dedupe key
- `params`: optional JSON object passed to the workflow body

Calling `create` again with the same idempotency inputs returns the existing
workflow instead of starting a duplicate. Kody enforces a per-user concurrent
workflow limit (default: 100); if the cap is reached, `workflows.create` returns
a clear quota error.

Use `workflow_list` to inspect recent workflow runs and statuses.

## Package export example

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		packageId: 'pkg_123',
		exportName: './workflow-run-event',
		runAt: '2026-05-08T18:00:00.000Z',
		idempotencyKey: 'morning-shades-up',
		params: { roomId: 'office' },
	})
}
```

Saved package jobs and subscriptions that already call `workflows.create` do not
need to change. New code should use the hub-backed `workflows.create` API above;
older package workflow declarations remain functional during the compatibility
window.
