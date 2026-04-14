# Memory and conversation context

Kody supports two related memory features:

- **conversation-scoped suppression** via **`conversationId`**
- **long-term memory retrieval and persistence** via **`memoryContext`** and
  memory capabilities

## `conversationId`

**`conversationId`** ties related tool calls together. Omit it on the first call
to receive a server-generated id, then pass the returned id on follow-up calls
in the same conversation.

Kody uses this id to avoid surfacing the same long-term memory repeatedly in one
conversation.

## `memoryContext`

**`memoryContext`** is a short, task-focused hint the agent sends with normal
tool calls. Kody uses it to retrieve a small number of relevant long-term
memories for the current task.

Keep it brief and factual. Good fields include:

- current task
- current query
- important entities
- important constraints

## Automatic memory surfacing

When a signed-in agent includes **`memoryContext`**, Kody may return a small
number of relevant previously-unsurfaced memories alongside the normal tool
result.

That retrieval is:

- **conservative** — only a few memories
- **task-based** — driven by `memoryContext`
- **conversation-aware** — repeated memories are suppressed within the same
  `conversationId`

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

## Categories

Memory categories are freeform strings. Kody does not force a closed list.

Suggested examples:

- `preference`
- `identifier`
- `relationship`
- `workflow`
- `project`
- `profile`
