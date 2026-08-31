# Memory and conversation context

Kody is the system of record for the signed-in user's durable assistant state.
Long-term memories are the primary store for facts and preferences. Memories
saved in Kody are available from every connected host for that user. Facts saved
only in the host (Claude memory, Codex notes, Cursor rules that are not also
Kody memories) are invisible to the user's other agents.

Kody supports two related memory features:

- **compact auto-surface** on `search` and on `execute` when `memoryContext` is
  present
- **long-term memory retrieval and persistence** via **`memoryContext`** and
  memory capabilities

## `conversationId`

**`conversationId`** ties related tool calls together for progressive disclosure
and other per-thread optimizations. If you already have one from an earlier tool
response, pass it back unchanged. Otherwise omit the field so Kody can return a
server-generated id. Do not make one up yourself.

Memory auto-surface does not require this id and does not hide a memory after
showing it. The compact one-liner can repeat on later retrievals so it stays in
context if earlier tool results were dropped. A different conversation, or a
completely separate agent for the same user, sees the same compact block.

## `memoryContext`

**`memoryContext`** is a short, task-focused hint the agent sends with normal
tool calls. Kody uses it to retrieve a small number of relevant long-term
memories for the current task.

Keep it brief and factual. Good fields include:

- current task
- current query
- important entities
- important constraints

`search` also retrieves from the query string when `memoryContext` is omitted,
including domain-scoped search. `execute` retrieves when `memoryContext` is
present.

## Automatic memory surfacing

When retrieval runs, Kody may return the top one or two relevant active
memories, including ones surfaced earlier, in the tool text (as
`## Relevant memories`) and in structured content. Auto-surface is compact:
**subject**, **summary**, and **id** (structured). Details stay behind
`meta_memory_get`. Later ranked hits that share a non-empty `dedupe_key` are
collapsed so two copies of the same fact cannot spend both slots; blank or
missing keys surface independently.

That retrieval is:

- **conservative** — the top one or two ranked active memories after
  `dedupe_key` collapse
- **task-based** — driven by `memoryContext` and, for `search`, the query
- **cheap to repeat** — subject and summary only; the same one-liners may appear
  again so a compacted context keeps the rule

## Verify-first rule for memory writes

Agents must treat long-term memory writes as an explicit workflow.

If the agent believes durable memory should be created, updated, or deleted, it
should:

1. call **`meta_memory_verify`** first
2. review the related memories returned by verify
3. decide whether to:
   - upsert a memory
   - delete a memory
   - do both
   - do nothing

Kody helps retrieve related memories, but the **consuming agent** is responsible
for deciding what those related memories mean.

## Memory capabilities

Use these through **`execute`**:

- **`meta_memory_verify`** — required first step before mutating memory
- **`meta_memory_upsert`** — create a new memory when `memory_id` is omitted, or
  update an existing memory when `memory_id` is provided
- **`meta_memory_delete`** — soft-delete by default; pass `force: true` for
  permanent deletion
- **`meta_memory_get`** — load one stored memory by id
- **`meta_memory_search`** — browse/search stored memories directly

Memory records can also include optional **`source_uris`** — opaque canonical
document URLs such as GitHub files, R2 object URLs, or Notion pages.

## Account download

The signed-in user can download their own memories as JSON from
`/account/memories`. The file is memories only: no credentials or other account
primitives. Deleted memories are included only when **Include deleted** is on.

## Categories

Memory categories are freeform strings. Kody does not force a closed list.

Suggested examples:

- `preference`
- `identifier`
- `relationship`
- `workflow`
- `project`
- `profile`
