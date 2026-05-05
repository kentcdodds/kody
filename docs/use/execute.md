# Execute and workflows

**execute** runs one ephemeral **ES module** inside Kody's runtime. That module
uses normal **imports** and **exports** and must **default export** the entry
function Kody should invoke.

## Shape of the code

Author code as one module string. Import runtime APIs from **`kody:runtime`**
and export a default function. These helpers are runtime exports:

- use **`import { codemode } from 'kody:runtime'`** to call builtin capabilities
- use
  **`import { refreshAccessToken, createAuthenticatedFetch } from 'kody:runtime'`**
  for connector OAuth helpers
- use **`import { storage } from 'kody:runtime'`** when the execute call is
  bound to a storage id
- use **`import { agentChatTurnStream } from 'kody:runtime'`** for streamed
  agent turns
- use **`import { params } from 'kody:runtime'`** when shared helpers need the
  active execute or job params instead of receiving them as a function argument
- use **`import { packageContext } from 'kody:runtime'`** inside saved package
  code when you need package metadata; it is **`null`** for ad hoc execute calls
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
  saved package export by full package name

**execute** also accepts optional **`params`**. Kody passes that JSON object to
the module's **default export**.

Top-level `await` is acceptable when needed.

## Chaining

Prefer **one execute** when the plan is clear: import what you need, call
several capabilities or package exports, branch on results, and return the final
structured result. Split into multiple **execute** calls only when you need new
user input, confirmation, or a result that changes the plan.

To read field shapes while coding, use **search** with
**`entity: "{name}:capability"`** for builtin capability type definitions, or
inspect the relevant saved package with **`entity: "{kody_id}:package"`**.

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
  **`codemode.job_schedule(...)`** without creating a saved package
- **`codemode.job_schedule_once(...)`** provides a convenience alias for one-off
  schedules
- **`codemode.job_update(...)`** updates an existing scheduled job by id for
  safe mutable fields such as name, code, params, schedule, timezone,
  enabled/disabled state, or kill switch state
- **`codemode.job_delete(...)`** removes an existing scheduled job by id for the
  signed-in user
- **`codemode.job_run_now(...)`** runs an existing scheduled job immediately and
  returns both the updated job state and the execution result for debugging

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

Kody exposes two generic primitives for tool-using chat turns:

- **`agentChatTurnStream(input)`** — an async iterable helper available through
  `kody:runtime`. Use this when your code needs incremental events such as
  reasoning deltas, tool call notifications, and a final `turn_complete`
  message.
- **`codemode.agent_chat_turn(args)`** — a normal final-value capability
  wrapper. Use this when you only need the completed result and do not need to
  process stream events manually.

Typical pattern inside execute:

- use **`import { agentChatTurnStream } from 'kody:runtime'`** when interactive
  controllers need to forward progress over time
- use **`codemode.agent_chat_turn(...)`** in package jobs or workflows that only
  need the final answer

### Prompt caching for stable prefixes

Agent turns accept the existing string-only prompt shape, plus an optional
cache-hint form for prompts with a stable prefix:

```ts
await codemode.agent_chat_turn({
	sessionId: 'email-follow-up',
	system: {
		content: stableSystemPrompt,
		cache: 'prefix',
	},
	messages: [
		{
			role: 'user',
			content: normalizedThreadContext,
			cache: 'prefix',
		},
		{
			role: 'user',
			content: latestInboundEmail,
		},
	],
})
```

Use `cache: 'prefix'` only on prompt segments that are intentionally stable
across repeated turns. Kody translates that hint into provider-specific cache
controls only when the configured model/provider supports prompt caching. For
other providers, the hint is ignored with no behavior change.

For follow-up email workflows, structure prompts in this order:

1. **Stable system prompt first** - instructions, policy, response style,
   tool-use guidance
2. **Stable normalized thread context next** - summarize or normalize the
   earlier thread so repeated quoted content stays stable
3. **Current latest email last** - put the newest inbound email content after
   the cached prefix so only the changing tail invalidates less cached work

Prefer normalizing long quoted threads before passing them into the agent turn
instead of appending raw mailbox history every time. That keeps the stable
prefix stable enough to benefit from caching and makes the final changing email
content easier for the model to prioritize.

## Storage

Kody supports durable storage binding for execute and scheduled jobs, including
package-owned jobs and non-package jobs created with `job_schedule` or
`job_schedule_once`.

- bound storage is execute-, app-, package-, or job-owned durable state
- package service runs also get writable service-owned durable state scoped to
  the declared service name
- package service runs are background-managed by the service Durable Object, so
  `service_start` returns immediately with a running state while the service
  code continues in the background until it finishes, errors, or cooperatively
  stops
- import **`storage`** from **`kody:runtime`**
- use **`storage.get(...)`**, **`storage.set(...)`**, **`storage.list(...)`**,
  and **`storage.sql(query, params?)`**

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
Pass an empty string to clear it. Changes apply to new MCP sessions, so
reconnect the MCP client if the host caches server instructions.

## Network and OAuth helpers

The sandbox exposes global **`fetch`** plus secret placeholders in approved
contexts. OAuth helpers are imported from **`kody:runtime`**:

**`import { refreshAccessToken, createAuthenticatedFetch } from 'kody:runtime'`**

See [Secrets, values, and host approval](./secrets-and-values.md) for
placeholders, host approval, and **`codemode.secret_list`** / **`secret_set`**.

Treat placeholder syntax as operational wiring, not prose. Do not place the
exact **`{{secret:...}}`** token into issue bodies, comments, prompts, logs, or
other content that may be shown to users or sent to third parties. If you need
to mention a placeholder literally, obfuscate it instead of embedding the exact
token.

## Values

Readable non-secret configuration uses **`codemode.value_get`** and
**`codemode.value_list`** (for example data generated UI should persist).

## Returning content blocks

By default, **`execute`** returns text output. To return non-text MCP content
blocks such as images, return an object with a **`__mcpContent`** array instead;
see [Raw MCP content blocks](./raw-content-blocks.md).
