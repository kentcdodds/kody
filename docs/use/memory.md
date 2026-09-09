# Memory and conversation context

What a memory is, what does not belong in one, and the verify-first write
workflow live in [Shared memory](../guides/memory.md). This page is the
MCP-level reference: `conversationId`, `memoryContext`, and retrieval behavior.

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
`metaMemoryGet`. Later ranked hits that share a non-empty `dedupe_key` are
collapsed so two copies of the same fact cannot spend both slots; blank or
missing keys surface independently.

That retrieval is:

- **conservative** — the top one or two ranked active memories after
  `dedupe_key` collapse
- **task-based** — driven by `memoryContext` and, for `search`, the query
- **cheap to repeat** — subject and summary only; the same one-liners may appear
  again so a compacted context keeps the rule

## Verify-first rule for memory writes

Before creating, updating, or deleting a memory, call **`metaMemoryVerify`**,
review the related memories it returns, then upsert, delete, do both, or do
nothing. Kody retrieves the related memories; the consuming agent decides what
they mean. See [Shared memory](../guides/memory.md#writing-memory-verify-first).

## Memory capabilities

Use these through **`execute`**:

- **`metaMemoryVerify`** — required first step before mutating memory
- **`metaMemoryUpsert`** — create a new memory when `memory_id` is omitted, or
  update an existing memory when `memory_id` is provided
- **`metaMemoryDelete`** — soft-delete by default; pass `force: true` for
  permanent deletion
- **`metaMemoryGet`** — load one stored memory by id
- **`metaMemorySearch`** — browse/search stored memories directly

Memory records can also include optional **`source_uris`** — opaque canonical
document URLs such as GitHub files, R2 object URLs, or Notion pages.

## Account download and categories

Download memories as JSON from `/account/memories`. Categories are freeform;
suggested values and the account-download details are in
[Shared memory](../guides/memory.md).
