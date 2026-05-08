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

Calling `create` again with the same dedupe fields returns the existing workflow
instead of starting a duplicate. For inline code, repeat the same signed-in
user, source type (`code`), workflow name (or the default `inline-code`),
`idempotencyKey`, and `runAt`. For package exports, repeat the same signed-in
user, package, workflow name (or export name fallback), `idempotencyKey`, and
`runAt`. For example, retrying `code` with `idempotencyKey: "execute-smoke-123"`
and `runAt: "2026-05-08T18:00:00.000Z"` returns the same workflow only when
those dedupe fields are repeated. Kody enforces a per-user concurrent workflow
limit (default: 100); if the cap is reached, `workflows.create` returns a clear
quota error.

Use `workflow_list` to inspect recent workflow runs and statuses.

## Package export example

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		packageId: 'pkg_123',
		exportName: './workflow-run-event',
		runAt: new Date(Date.now() + 60_000).toISOString(),
		idempotencyKey: 'morning-shades-up',
		params: { roomId: 'office' },
	})
}
```

Saved package jobs and subscriptions call the same `workflows.create` helper.
Manifests no longer declare workflow entrypoints under `kody.workflows`; the hub
resolves any package export by name at runtime, so calling
`workflows.create({ exportName: './workflow-run-event' })` from a package
runtime context is enough.
