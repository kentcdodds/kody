# Execute and workflows

**execute** runs an async JavaScript function inside a sandbox. The sandbox
exposes **`codemode`** — one async method per **builtin capability name**
discovered through **search**.

## Shape of the code

The code must be an **async arrow function** that returns a value. Each
capability call takes one **args** object that matches that capability’s
**inputSchema** and returns data that matches its **outputSchema** when one
exists.

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

## Saved skills

To run persisted user code by name, use **`meta_run_skill`** with **`name`** and
optional **`params`**. To inspect source, use **`meta_get_skill`**. You can also
inline saved skill code into **execute** when that fits the workflow.

## Jobs

Kody has one persisted jobs system per user:

- **`job_upsert`** — create a new job, or update an existing one when you pass
  **`id`**
- **`job_list`** — list jobs with next run time, last run status, counters, and
  a human-readable schedule summary
- **`job_get`** — inspect one job
- **`job_delete`** — remove a job
- **`job_run_now`** — trigger a job immediately without changing its normal
  schedule

Jobs always run through codemode and always have durable storage:

- **`code`** stores the async arrow function source and runs through the same
  execute/capability runtime as normal `execute`
- Each job has a stable **`storageId`** that identifies its durable storage
  bucket
- Scheduled jobs run with writable storage access by default
- Ad hoc execute calls can bind to a storage bucket with **`storageId`** and use
  **`storage.get(...)`**, **`storage.set(...)`**, **`storage.list(...)`**, and
  **`storage.sql(query, params?)`**

Schedules support:

- **cron** — standard **5-field cron syntax**, optionally with an IANA timezone
  such as **`America/New_York`**
- **interval** — fixed durations such as **`15m`**, **`1h`**, or **`1d`**
- **once** — an ISO 8601 UTC timestamp such as **`2026-04-17T15:00:00Z`**

When you need dedicated inspection instead of ad hoc code, use:

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
