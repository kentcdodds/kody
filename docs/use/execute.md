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

## Scheduled jobs

Kody can persist alarm-driven scheduled jobs for the signed-in user:

- **`job_create`** — create a new scheduled Durable Object facet job
- **`job_update`** — update a saved job in place; changing `serverCode` rotates
  `serverCodeId`
- **`job_list`** — list jobs with schedule summary, next run time, counters, and
  last error
- **`job_get`** — inspect one job
- **`job_delete`** — remove the saved job and delete its facet storage
- **`job_run_now`** — trigger a run immediately without changing the normal next
  scheduled fire time
- **`job_enable`** / **`job_disable`** — toggle alarm scheduling
- **`job_history`** — inspect recent supervisor-tracked run history
- **`job_storage_reset`** — clear the facet SQLite database while keeping the
  job
- **`job_server_exec`** — run one-off JavaScript inside the facet for debugging
  or migrations

Jobs define **`serverCode`** that exports **`class Job extends DurableObject`**
with an async **`run()`** method. The supervisor Durable Object loads that code
as a facet through Cloudflare's Dynamic Worker loader, keeps its own separate
SQLite status/history tables, and re-arms alarms after every run.

Schedules support either:

- cron: `{ cron: "0 8 * * *" }`
- interval: `{ intervalMs: 3600000 }`

Cron schedules use standard **5-field cron syntax** and an IANA timezone such as
**`America/Denver`**.

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
