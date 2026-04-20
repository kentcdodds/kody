# Execute and workflows

**execute** runs one ephemeral **ES module** inside Kody's runtime. That module
uses normal **imports** and **exports** and must **default export** the entry
function Kody should invoke.

## Shape of the code

Author code as one module string. Import runtime APIs from **`kody:runtime`**
and export a default function. These helpers are runtime exports, not ambient
globals:

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
  code when you need package metadata; it is **`null`** for ad hoc execute
  calls
- use **`import thing from 'kody:@my-package/export-name'`** to reuse a saved
  package export

**execute** also accepts optional **`params`**. Kody passes that JSON object to
the module's **default export**.

Top-level `await` is acceptable when needed.

## Chaining

Prefer **one execute** when the plan is clear: import what you need, call
several capabilities or package exports, branch on results, and return the final
structured result. Split into multiple **execute** calls only when you need new
user input, confirmation, or a result that changes the plan.

To read field shapes while coding, use **search** with
**`entity: "{name}:capability"`** for builtin capability schemas, or inspect the
relevant saved package with **`entity: "{kody_id}:package"`**.

## Saved packages

Saved packages, scheduled jobs, and one-off **execute** code share the same
module-oriented runtime model:

- saved packages persist repo-backed source rooted at `package.json`
- package exports are defined by standard `package.json.exports`
- package-specific metadata lives under `package.json#kody`
- package jobs are schedules declared under `package.json#kody.jobs`
- package apps are optional UI surfaces declared under `package.json#kody.app`
- non-package jobs can also be scheduled directly with
  **`codemode.job_schedule(...)`** without creating a saved package
- **`codemode.job_schedule_once(...)`** remains available as a convenience alias
  for one-off schedules

When you need to edit saved source, prefer the repo-backed workflow in
[Repo-backed editing sessions](./repo-sessions.md). Open by package identity
instead of internal source ids whenever possible.

For common edit-and-check workflows, `repo_edit_flow` returns session, checks,
and publish detail in one response. The nested `edits.edits` array is omitted by
default to keep that response smaller, and can be requested explicitly when a
caller needs the concrete diff in the same call.

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

- use
  **`import { agentChatTurnStream } from 'kody:runtime'`**
  when interactive controllers need to forward progress over time
- use **`codemode.agent_chat_turn(...)`** in package jobs or workflows that only
  need the final answer

## Storage

Kody supports durable storage binding for execute and scheduled jobs,
including package-owned jobs and non-package jobs created with
`job_schedule` or `job_schedule_once`.

- bound storage is execute-, app-, package-, or job-owned durable state
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

Kody retrieves related memories, but the **consuming agent** remains responsible
for deciding what action to take.

## MCP server instructions

Users can read or replace their own MCP server instruction overlay with
**`meta_get_mcp_server_instructions`** and
**`meta_set_mcp_server_instructions`**.

This overlay is appended to Kody's built-in server instructions for that user.
Pass an empty string to clear it. Changes apply to new MCP sessions, so
reconnect the MCP client if the host caches server instructions.

## Network and OAuth helpers

The sandbox exposes global **`fetch`** plus secret placeholders in approved
contexts. OAuth helpers are **not** globals: import
**`refreshAccessToken`** and **`createAuthenticatedFetch`** explicitly from
**`kody:runtime`**:

**`import { refreshAccessToken, createAuthenticatedFetch } from 'kody:runtime'`**

See [Secrets, values, and host approval](./secrets-and-values.md) for
placeholders, host approval, and **`codemode.secret_list`** /
**`secret_set`**.

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
