# Execute and workflows

**execute** runs one ephemeral **ES module** inside Kody's runtime. That module
uses normal **imports** and **exports** and must **default export** the entry
function Kody should invoke.

## Shape of the code

Author code as one module string. Export a default function that receives the
execute/job/package input as its first argument:

```ts
export default async function main(input = {}) {
	// Use input directly, or pass it to shared helpers.
}
```

Import runtime APIs from **`kody:runtime`** when you need Kody helpers. These
helpers are runtime exports:

- use **`import { kody } from 'kody:runtime'`** to call builtin capabilities
  discovered by **search** as **`await kody.capability_id(input)`** for valid
  identifier names, or **`await kody["capability-id"](input)`** for
  non-identifier capability ids
- use
  **`import { refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials } from 'kody:runtime'`**
  for OAuth helpers
- use **`import { secretHeaders } from 'kody:runtime'`** when an approved
  `fetch` request needs host-derived auth headers from saved secrets, such as
  Basic Auth from a saved client id and client secret
- use **`import { storage } from 'kody:runtime'`** when the execute call is
  bound to a storage id
- use **`import { packageStorage } from 'kody:runtime'`** inside saved-package
  code for the package's own bucket — always, in every package surface; see
  [Package storage](./packages.md#package-storage)
- use **`import { workflows } from 'kody:runtime'`** to queue Cloudflare
  Workflows from execute calls, ad hoc jobs, package jobs, package
  subscriptions, package services, and package exports. Prefer workflows for
  durable batch sweeps, migrations, polling loops, retryable steps, or work that
  may run longer than execute's timeout. See [Workflows](./workflows.md)
- use **`import { packageContext } from 'kody:runtime'`** inside saved package
  code when you need package metadata; it is **`null`** for ad hoc execute calls
- use **`import { packages } from 'kody:runtime'`** inside saved package runtime
  contexts or authenticated execute calls when a package call must be dynamic:
  the target's name is data, the call needs the target package's own runtime, or
  you need exactly-once. `packages.invoke({ kodyId, exportName, params })` (plus
  an optional `idempotencyKey` field for exactly-once calls) is the only dynamic
  call and is always contract-checked before invoking. Pass the bare
  `package.json#kody.id` as `kodyId` (for example, `github`), not the npm-scoped
  `package.json.name` (for example, `@kentcdodds/github`). When the target
  package's name is known when the code is written, use a static `kody:@...`
  import instead (see below)
- use **`import { serviceContext } from 'kody:runtime'`** inside package service
  code when you need the current service identity; it is **`null`** outside
  package service runs
- package service runs also expose **`service`** through **`kody:runtime`** for
  background lifecycle control:
  - `await service.getStatus()` — read the current package-service status
  - `await service.shouldStop()` — cooperatively observe stop requests
  - `await service.setAlarm(runAt)` — schedule the next service wake-up
  - `await service.clearAlarm()` — clear a pending service wake-up
- package service runs may also declare **`kody.services.<name>.timeoutMs`** in
  `package.json` when they need a longer executor budget than the default
  package-service timeout
- use **`import thing from 'kody:@scope/my-package/export-name'`** or
  **`import { helper } from 'kody:@scope/my-package/export-name'`** to reuse a
  saved package export by npm-scoped package name. This is **the default for
  package reuse** whenever the target package's name is known when the code is
  written: static imports are publish-verified (repo checks prove the export
  exists), dependency-graph-visible (`kody.dependencies`, dependents tracking),
  and have zero per-call platform cost. Ad hoc execute bundles per call, so
  static imports from execute always see the current published version; snapshot
  staleness only affects package-to-package static dependencies, which keep the
  bundled snapshot until the dependent republishes.

`kody:runtime` is always supplied by the Kody host at execution time. Saved
package artifacts do not contain a copy of the host runtime implementation, so
old package artifacts automatically observe current host runtime behavior.

Literal dynamic imports (`await import('kody:@scope/my-package/export-name')`)
were **removed**. The call site throws a teaching error naming the replacement:
use a static `kody:@...` import when the target package's name is known when the
code is written, or `packages.invoke` when it is not. Computed dynamic Kody
package imports, including variables and template strings, have never been
supported.

**execute** also accepts optional **`params`**. Kody passes that JSON object to
the module's **default export** as the first function argument. Shared helpers
should receive that input through normal function arguments.

Top-level `await` is acceptable when needed.

## Pre-execution module diagnostics

Kody can validate an ad hoc execute module before starting its sandbox. This is
controlled by the **`execute-pre-exec-typecheck`** feature flag and is off by
default. During the initial rollout, only explicitly opted-in users receive the
check. The public **execute** tool and the nested **`meta.execute`** capability
use the same caller-scoped flag; saved-package exports, jobs, workflows, and
services are not changed by this flag.

When enabled, the check validates source size, module syntax (TypeScript-aware
parse), and the presence of the default export the execute runtime calls.
Failures are returned through the normal execute error result with
`entry.ts:line:column` diagnostics before the module's default export runs —
catching truncated or malformed modules without paying for sandbox startup. The
check is deliberately **not semantic**: type-level errors (wrong argument or
result types against published `kody:@…` package contracts) are not reported,
because running a TypeScript compiler inside the serving isolate proved unsafe
in production (memory and CPU spikes stalled unrelated execute calls on the same
session). Operators can disable the user's override (or the global flag, if a
broader rollout was started) to return immediately to the previous
bundle-and-run behavior.

### Server-Timing phases

Execute responses include Server-Timing-style phase entries under
**`timing.serverTiming`** (public tool) or top-level **`serverTiming`**
(`meta.execute`): each entry is `{ name, durationMs }`.

- `bundle` — module-graph preparation and bundling.
- `hydrate` — refreshing nested runtime modules (and resolving literal dynamic
  `import("kody:@…")` placeholders in bundles published before that pattern was
  removed).
- `provider-assembly` — capability registry, runtime helper, and provider wiring
  ahead of sandbox startup.
- `sandbox` — the dynamic worker evaluation of the module itself.
- `run` — the enclosing span for the three phases above (plus run-record and
  usage bookkeeping).
- `typecheck-semantic-skipped`, `typecheck-parse`, `typecheck-total` — present
  only when the pre-execution check ran for the call.
  `typecheck-semantic-skipped` is a 0ms marker recording that no type-level
  (semantic) checking ran. Failed diagnostics also report these phases so the
  check can be attributed even when the module never executes.

Phase durations are measured with `Date.now()`, which the Workers runtime only
advances across I/O boundaries — synchronous CPU inside one phase can be
attributed to the next timer read. Treat phases as attribution for slow spans,
not precise CPU accounting.

## npm packages on Workers

**execute** and saved packages may import npm packages directly when they are
compatible with the Cloudflare Workers runtime. Prefer existing packages over
rewriting helpers; useful starting points include `p-retry`, `mailparser`,
`remark` / `mdast-util-to-markdown`, and `googleapis`.

For runtime details, see Cloudflare's
[Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

## Chaining

Prefer **one execute** when the plan is clear: import what you need, call
several capabilities or package exports, branch on results, and return the final
structured result. Split into multiple **execute** calls only when you need new
user input, confirmation, or a result that changes the plan.

Plain **execute** has a hard timeout (~90s by default). For multi-step or
long-running work (>~60s, batch sweeps, migrations, polling loops), use one
**execute** call to submit `workflows.create({ code, params })`, then inspect
progress with `workflow_run_list` instead of chaining many MCP tool calls.

### Recovering from MCP client timeouts

Some MCP clients abort the tool call (for example error `-32001` Request timed
out) while Kody’s sandbox may still be running. Key-less successful execute
calls are not written to Activity, so that timeout can leave you unsure whether
side effects already happened.

Pass an optional **`idempotencyKey`** (string, max 256 characters) when the call
must be recoverable:

- Kody persists that execute run **eagerly** (a `running` row at start, terminal
  row at finish) and stores a **bounded result snapshot** on the run record.
- The tool response includes **`runId`** whenever a record exists — poll
  **`run_get`** with it if the client timed out.
- Retrying with the **same** `idempotencyKey` after completion returns the
  retained result with **`replayed: true`** and the same **`runId`** (no second
  sandbox).
- Retrying while the first attempt is still running returns
  **`inProgress: true`** with the **`runId`** (no duplicate start).
- If a keyed run is stranded as `running` (for example the Worker isolate reset
  before the terminal write), Kody reconciles it to an **Interrupted** error
  after a few minutes. Polling **`run_get`** or retrying the same key then
  returns that terminal outcome instead of `inProgress` forever.

Omit the key for ordinary short calls; key-less execute stays on-failure-only so
Activity is not flooded with successful one-offs.

To read field shapes while coding, use **search** with
**`entity: "{name}:capability"`** for builtin capability type definitions, or
inspect the relevant saved package with **`entity: "{kody_id}:package"`**.
Capability detail includes a complete **execute** module snippet; the runtime
call itself is always through the imported `kody` object.

## Saved packages

Saved packages, scheduled jobs, and one-off **execute** code share the same
module-oriented runtime model:

- saved packages persist repo-backed source rooted at `package.json`
- `package.json.name` must end with the same leaf name as `package.json#kody.id`
  (for example `@scope/my-package` pairs with `kody.id: "my-package"`)
- package exports are defined by standard `package.json.exports`
- package-specific metadata lives under `package.json#kody`
- package jobs are schedules declared under `package.json#kody.jobs`
- package apps are optional UI surfaces declared under `package.json#kody.app`
- package services are optional long-lived runtimes declared under
  `package.json#kody.services`
- non-package jobs can also be scheduled directly with
  **`kody.job_schedule(...)`** without creating a saved package
- **`kody.job_schedule_once(...)`** provides a convenience alias for one-off
  schedules
- **`kody.job_update(...)`** updates an existing scheduled job by id for safe
  mutable fields such as name, ES module code with a default-exported function,
  params, schedule, timezone, enabled/disabled state, kill switch state,
  preserved, or `expires_at` (UTC ISO; null clears). Providing `code`
  republishes the job's repo-backed source so subsequent runs execute the
  updated module; the replacement must default export a function that receives
  `params` from its first argument (there is no `params` export from
  `kody:runtime`)
- Optional **`expires_at`** on `job_schedule` / `job_schedule_once` /
  `job_update` stops the platform from scheduling the job after that UTC time.
  When expiry is reached, Kody auto-disables the job (`enabled=false`) so it
  shows as disabled in `job_list` / `job_get` (with `expired: true`) and can age
  out via normal retention. This is separate from **`preserved`**, which only
  skips auto-deletion.
- **`kody.job_get({ id, includeCode: true })`** returns the scheduled job
  inspection details plus the stored repo-backed entrypoint path and source code
  when you need to inspect the current module before changing it
- **`kody.job_delete(...)`** removes an existing scheduled job by id for the
  signed-in user
- **`kody.job_run_now(...)`** runs an existing scheduled job immediately and
  returns both the updated job state and the execution result for debugging.
  Expired jobs are rejected.

Static saved-package imports from ad hoc **execute** run under the ad hoc
execute runtime. That means imported package modules can share exported helpers,
but `packageContext` remains **`null`** because the imported module has not been
entered as its own package runtime. This is fine for most reuse — packages
backed by user-scope secrets (for example `github`) work fully through plain
static imports because `{{secret:...}}` placeholders resolve at the fetch
gateway under the calling user. When execute must enter a saved package export
as that package — package-mounted secrets (`kody.secretMounts`),
`packageContext`, the package's own `packageStorage()` bucket — use keyless
`packages.invoke` from `kody:runtime`. It resolves the bare `kodyId`, such as
`my-package`, rather than the npm-scoped package name, such as
`@scope/my-package`.

When you need to edit saved source, prefer the repo-backed workflow in
[Repo-backed editing sessions](./repo-sessions.md). Open by package identity
instead of internal source ids whenever possible.

For common edit-and-check workflows, `repo_run_commands` accepts a
newline-separated parsed git-command string, returns command outputs, and can
run checks plus publish in one response. Commands are parsed by Kody; they are
not arbitrary shell, only the documented git forms are supported, and
`git clone` is intentionally unsupported because Kody opens repo sessions for
you.

## Agent turns

Generic tool-using agent turns are package-owned behavior rather than a built-in
runtime primitive. Search for an agent-turn package, then import that package
from execute or another saved package.

## Storage

One rule per context: ad hoc execute code binds a `storageId` on the call and
uses ambient `storage`; saved-package code always uses `packageStorage()` for
the package's own data; another package's data goes through keyless
`packages.invoke` so its own runtime does the reading and writing. See
[Package storage](./packages.md#package-storage).

Kody supports durable storage binding for execute and scheduled jobs, including
package-owned jobs and non-package jobs created with `job_schedule` or
`job_schedule_once`.

- bound storage is execute-, app-, or job-owned durable state; saved-package
  invocation runs (exports, subscriptions, retrievers) bind no ambient `storage`
  — package code, including package apps, reaches the shared package bucket
  through `packageStorage()`
- package service runs also get writable service-owned durable state scoped to
  the declared service name; shared durable data still uses `packageStorage()`
- package service runs are background-managed by the service Durable Object, so
  `service_start` returns immediately with a running state while the service
  code continues in the background until it finishes, errors, or cooperatively
  stops
- import **`storage`** from **`kody:runtime`**
- use **`storage.get(...)`**, **`storage.set(...)`**, **`storage.list(...)`**,
  and **`storage.sql(query, params?)`**

Both `storage` and `packageStorage()` expose the same interface; everything
below applies to both.

`storage.sql(...)` returns a result object, not the row array directly:

```ts
const result = await storage.sql('select value from counters')

return {
	columns: result.columns,
	rows: result.rows,
	rowCount: result.rowCount,
	rowsRead: result.rowsRead,
	rowsWritten: result.rowsWritten,
}
```

Read query rows from **`result.rows`**. The other fields are useful for
inspection and debugging, especially when validating whether a query read or
wrote storage.

For dedicated inspection, use:

- **`storage_export`** — export one storage bucket as JSON
- **`storage_query`** — run SQL against one storage bucket (read-only by
  default, opt into writes explicitly)

## Long-term memory

Kody can surface a small number of relevant long-term memories when you pass a
short **`memoryContext`** with **`conversationId`** on normal MCP tool calls.

Handled **execute** responses also include top-level **`timing`** metadata with
`startedAt`, `endedAt`, and `durationMs` alongside `conversationId`. Use it for
basic latency instrumentation around tool runs.

For memory mutations, the workflow is explicit and strict:

- **Always run `meta_memory_verify` before writing or deleting memory**
- then decide whether to call **`meta_memory_upsert`**,
  **`meta_memory_delete`**, both, or neither
- **`meta_memory_upsert`** creates a new memory when **`memory_id`** is omitted
  and updates an existing memory when **`memory_id`** is provided

Kody retrieves related memories, but the **consuming agent** is responsible for
deciding what action to take.

## MCP server instructions

Users can read or replace their own MCP server instruction overlay with
**`meta_get_mcp_server_instructions`** and
**`meta_set_mcp_server_instructions`**.

This overlay is appended to Kody's built-in server instructions for that user.
Use it for preferences and workflow notes only — not for maintaining a package
inventory. When agents have used saved packages via MCP `execute`, Kody may
include a short “often used from agents” hint of those packages automatically;
discover others with **`search`**. Pass an empty string to clear the overlay.
Changes apply to new MCP sessions, so reconnect the MCP client if the host
caches server instructions.

## Network and OAuth helpers

The sandbox exposes global **`fetch`** plus secret placeholders in approved
contexts. OAuth and secret-header helpers are imported from **`kody:runtime`**:

**`import { refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials, secretHeaders } from 'kody:runtime'`**

`createAuthenticatedFetch(providerName)` is async. Await it before calling the
returned fetch wrapper:

```ts
const googleFetch = await createAuthenticatedFetch('google-business')
const response = await googleFetch('/calendar/v3/users/me/calendarList')
```

Integration names should usually follow `<provider>-<purpose>` when multiple
accounts may exist, such as `google`, `google-business`, or
`google-youtube-brand`. Call **`integration_list`** up front when a provider may
have multiple accounts connected.

OAuth integrations may include `authorization` metadata with the saved
`authorizeUrl`, requested `scopes`, any non-default `scopeSeparator`, and
provider-specific `extraAuthorizeParams`. Use that metadata when a refresh token
is stale and the user needs to reconnect; open
`/connect/oauth?provider=<integration-name>` instead of guessing the scope set.

For OAuth 2 `client_credentials` token exchanges that require
`Authorization: Basic base64(client_id:client_secret)`, save the client id and
client secret separately. Do **not** ask the user to precompute or save the
derived Basic header. Use `secretHeaders.basic(...)` directly in a fetch header,
or use `oauthClientCredentials(...)` for the token request. These examples use a
placeholder API host and generic client credential secret names:

```ts
import { oauthClientCredentials } from 'kody:runtime'

export default async function main() {
	const token = await oauthClientCredentials({
		tokenUrl: 'https://api.example.com/oauth/token',
		clientIdSecret: 'exampleClientId',
		clientSecretSecret: 'exampleClientSecret',
		scope: 'user',
	})

	return { tokenType: token.token_type, hasAccessToken: !!token.access_token }
}
```

For the lower-level token request built directly with `secretHeaders.basic`, see
the worked example in
[Secrets, values, and host approval](./secrets-and-values.md).

Kody resolves both saved secrets server-side, requires the token endpoint host
to be approved for both secrets, and only sends the derived Basic header in the
outbound request.

See [Secrets, values, and host approval](./secrets-and-values.md) for
placeholders, host approval, **`kody.secret_list`** / **`secret_set`**, and the
rules for mentioning placeholder syntax without resolving it (the inert
`{{secret:<name>}}` form and the `x-kody-secret-resolution: off` header). Treat
placeholder syntax as operational wiring, not prose — never place a resolvable
**`{{secret:...}}`** token into content shown to users or sent to third parties.

## Values

Readable non-secret configuration uses **`kody.value_get`** and
**`kody.value_list`** (for example data package apps should persist).

## Returning content blocks

By default, **`execute`** returns text output. To return non-text MCP content
blocks such as images, return an object with a **`__mcpContent`** array instead;
see [Raw MCP content blocks](./raw-content-blocks.md).

The same passthrough applies when execute returns a result from a user-added MCP
server or remote connector that already includes protocol image (or other
non-text) content blocks.

**`responseLimit`** caps ordinary JSON/text output (~100 KB by default).
Protocol `__mcpContent` blocks use a separate ~512 KB content cap so valid
images larger than 100 KB are not collapsed into truncated JSON.
