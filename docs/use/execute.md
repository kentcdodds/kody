# Execute and workflows

**execute** runs an async JavaScript function inside a sandbox. The sandbox
exposes **`codemode`** — one async method per **builtin capability name**
discovered through **search**.

## Shape of the code

The code must be an **async arrow function** that returns a value. Each
capability call takes one **args** object that matches that capability’s
**inputSchema** and returns data that matches its **outputSchema** when one
exists.

In addition to **`codemode.<capabilityName>(args)`**, the sandbox may expose
small built-in helpers for common agent workflows. These helpers are not normal
MCP capabilities; they are runtime conveniences layered on top of the same
execute environment.

**execute** also accepts optional **`params`**. When provided, Kody injects that
JSON object as **`params`** when invoking your async function, so code like
**`async (params) => { ... }`** can read structured inputs without manually
stringifying them into the source.

## Chaining

Prefer **one execute** when the plan is clear: call several capabilities in a
row, branch on results, and return the final structured result. Split into
multiple **execute** calls when you need new user input, confirmation, or a
result that changes the plan.

To read field shapes while coding, use **search** with
**`entity: "{name}:capability"`** for full schema detail for that capability.

## Saved apps

Persist reusable automation as an **app**. A saved app can include:

- **tasks** — named execute-style entrypoints run with `app_run_task`
- **jobs** — scheduled entrypoints run with `app_run_job`
- **serverCode** — request/RPC backend code
- **clientCode** — optional generated UI

Saved app tasks and jobs execute through the same codemode runtime as
**`execute`**, including helper globals such as **`refreshAccessToken(...)`**,
**`createAuthenticatedFetch(...)`**, **`agentChatTurnStream(...)`**, and job
storage helpers. Saved sources use repo-backed ES module entrypoints, so they
can import sibling modules and package dependencies.

When you need to edit saved source, prefer the repo-backed workflow in
[Repo-backed editing sessions](./repo-sessions.md). For common edits, use
**`repo_edit_flow`** with the app **`app_id`** rather than the internal
`source_id`.

## Agent turns

Kody exposes two generic primitives for tool-using chat turns:

- **`agentChatTurnStream(input)`** — an async iterable helper available inside
  the execute sandbox. Use this when your code needs incremental events such as
  reasoning deltas, tool call notifications, and a final `turn_complete`
  message.
- **`codemode.agent_chat_turn(args)`** — a normal final-value capability
  wrapper. Use this when you only need the completed result and do not need to
  process stream events manually.

Typical pattern inside execute:

- use **`agentChatTurnStream(...)`** for interactive controllers that need to
  forward progress over time
- use **`codemode.agent_chat_turn(...)`** in jobs or workflows that only need
  the final answer

## App jobs

Each app can define zero or more scheduled **jobs**. Jobs have:

- a named **task** they invoke
- a stable **storageId**
- run history, counters, and next-run state
- schedule types:
  - **cron** — standard 5-field cron syntax with optional timezone
  - **interval** — fixed durations such as `15m`, `1h`, or `1d`
  - **once** — an ISO 8601 UTC timestamp

Run a job immediately with **`app_run_job`**. List or inspect jobs through
**`app_get`** / **`app_list`**.

Ad hoc **`execute`** calls can still bind to a storage bucket with
**`storageId`** and use:

- **`storage.get(...)`**
- **`storage.set(...)`**
- **`storage.list(...)`**
- **`storage.sql(query, params?)`**

For dedicated inspection, use:

- **`storage_export`** — export one storage bucket as JSON
- **`storage_query`** — run SQL against one storage bucket (read-only by
  default, opt into writes explicitly)

## Long-term memory

Kody can surface a small number of relevant long-term memories when you pass a
short **`memoryContext`** with **`conversationId`** on normal MCP tool calls.

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

The sandbox exposes **`fetch`**, secret placeholders in approved contexts,
**`refreshAccessToken(providerName)`**, and
**`createAuthenticatedFetch(providerName)`** for connector OAuth. See
[Secrets, values, and host approval](./secrets-and-values.md) for placeholders,
host approval, and **`codemode.secret_list`** / **`secret_set`**.

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
