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
  contexts or authenticated execute calls when you need dynamic current-version
  invocation through `packages.check(...)`, `packages.invoke(...)`, or
  `packages.invokeChecked(...)`. Prefer `invokeChecked` unless you already
  called `check` and are passing `check.invoke` to `invoke`. Pass the bare
  `package.json#kody.id` as `kodyId` (for example, `github`), not the npm-scoped
  `package.json.name` (for example, `@kentcdodds/github`)
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
  saved package export by npm-scoped package name. Unlike dynamic
  `packages.invokeChecked` calls, static `kody:@...` imports use the scoped name
  and are pinned to the dependency's published artifact when the caller is
  bundled.

`kody:runtime` is always supplied by the Kody host at execution time. Saved
package artifacts do not contain a copy of the host runtime implementation, so
old package artifacts automatically observe current host runtime behavior.

Use literal dynamic imports when package code needs the current published
version of another saved package export:

```ts
const helper = await import('kody:@scope/my-package/export-name')
```

Kody resolves that literal import at runtime for the signed-in user. Computed
dynamic Kody package imports, including variables and template strings, are not
supported.

**execute** also accepts optional **`params`**. Kody passes that JSON object to
the module's **default export** as the first function argument. Shared helpers
should receive that input through normal function arguments.

Top-level `await` is acceptable when needed.

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
  params, schedule, timezone, enabled/disabled state, or kill switch state.
  Providing `code` republishes the job's repo-backed source so subsequent runs
  execute the updated module; the replacement must default export a function
  that receives `params` from its first argument (there is no `params` export
  from `kody:runtime`)
- **`kody.job_get({ id, includeCode: true })`** returns the scheduled job
  inspection details plus the stored repo-backed entrypoint path and source code
  when you need to inspect the current module before changing it
- **`kody.job_delete(...)`** removes an existing scheduled job by id for the
  signed-in user
- **`kody.job_run_now(...)`** runs an existing scheduled job immediately and
  returns both the updated job state and the execution result for debugging

Static saved-package imports from ad hoc **execute** run under the ad hoc
execute runtime. That means imported package modules can share exported helpers,
but `packageContext` remains **`null`** because the imported module has not been
entered as its own package runtime. Authenticated execute calls may import
`packages` from `kody:runtime` and use `packages.check`, `packages.invoke`, or
`packages.invokeChecked`; prefer `packages.invokeChecked` when execute needs to
enter a saved package export so that target code receives its package runtime
context. Those methods resolve the bare `kodyId`, such as `my-package`, rather
than the npm-scoped package name, such as `@scope/my-package`.

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
the package's own data; another package's data goes through
`packages.invokeChecked`. See [Package storage](./packages.md#package-storage).

Kody supports durable storage binding for execute and scheduled jobs, including
package-owned jobs and non-package jobs created with `job_schedule` or
`job_schedule_once`.

- bound storage is execute-, app-, or job-owned durable state; saved-package
  invocation runs (exports, subscriptions, retrievers) bind no ambient `storage`
  — package code reaches its own bucket through `packageStorage()`
- package service runs also get writable service-owned durable state scoped to
  the declared service name
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

The lower-level token request is:

```ts
import { secretHeaders } from 'kody:runtime'

export default async function main() {
	const body = new URLSearchParams({ grant_type: 'client_credentials' })
	const response = await fetch('https://api.example.com/oauth/token', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: secretHeaders.basic({
				usernameSecret: 'exampleClientId',
				passwordSecret: 'exampleClientSecret',
				scope: 'user',
			}),
		},
		body,
	})
	return await response.json()
}
```

Kody resolves both saved secrets server-side, requires the token endpoint host
to be approved for both secrets, and only sends the derived Basic header in the
outbound request.

See [Secrets, values, and host approval](./secrets-and-values.md) for
placeholders, host approval, and **`kody.secret_list`** / **`secret_set`**.

Treat placeholder syntax as operational wiring, not prose. Do not place the
exact **`{{secret:...}}`** token into issue bodies, comments, prompts, logs, or
other content that may be shown to users or sent to third parties — resolution
runs on the final serialized request, so even string concatenation cannot keep a
literal placeholder out of it.

To **mention** the syntax in prose, use the inert form **`{{secret:<name>}}`** —
angle brackets are outside the placeholder name charset, so it never resolves
anywhere, now or downstream.

To deliberately deliver a **resolvable** literal placeholder to a third party
(for example, config that Kody itself resolves later), set the
**`x-kody-secret-resolution: off`** header on that fetch. The gateway strips the
header and skips resolution for that request only. The delivered text remains
one resolution step from the real secret, so use this sparingly.

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
