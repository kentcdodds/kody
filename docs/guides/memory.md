---
id: memory
title: Shared memory
summary:
  What a Kody memory is, why it lives on the account instead of in one host's
  chat, how memories surface automatically on search and execute, the
  verify-first rule for writes, and what does not belong in memory (package
  state, config, credentials). Load this when someone asks what their agents
  remember about them or how memory travels between agents.
category: platform
---

# Shared memory

A memory is a durable fact or preference attached to your Kody account. Say it
once in one agent and every other agent connected to the same account can use
it. That is the whole point: memory follows the person, not the product.

Facts saved only inside a host — Claude's memory, Codex notes, Cursor rules that
are not also Kody memories — are invisible to your other agents. Kody is the
system of record for the assistant state you want to keep.

## What a memory is for

Memories hold information worth carrying between conversations and between
agents:

- who you are and how you like things done (`preference`, `profile`)
- names, ids, and handles you keep re-typing (`identifier`)
- people and relationships that give tasks context (`relationship`)
- how a recurring piece of work should go (`workflow`, `project`)

Categories are freeform strings; those are suggestions, not a closed list.

## What a memory is not for

Kody has a home for each kind of state, and memory is only one of them:

| State                                  | Home                                  |
| -------------------------------------- | ------------------------------------- |
| A durable fact or preference about you | **Memory**                            |
| A credential                           | [Secrets](./secrets.md)               |
| A cursor, checkpoint, or runtime knob  | `packageStorage()` inside the package |
| Versioned configuration                | The package repository                |
| An OAuth login                         | An integration                        |

If the fact is about a package's job rather than about you, it does not belong
in memory.

## How memories surface

Your agent does not have to ask for memories. When it calls `search`, Kody
retrieves the one or two most relevant active memories for the query and adds
them to the response as a compact `## Relevant memories` block: subject,
summary, and id. `execute` does the same when the agent passes a short
`memoryContext` (the task, the query, key entities and constraints).

That auto-surface is deliberately small and repeatable. The same one-liner may
show up again later so the rule stays in context after a long conversation is
compacted. Details stay behind `metaMemoryGet`; two copies of the same fact
sharing a `dedupe_key` collapse into one so neither spends both slots.

A different conversation, or a completely separate agent for the same account,
sees the same block. That is portability in one screen.

## Writing memory: verify first

Memory writes are explicit. Before creating, updating, or deleting a memory the
agent should:

1. call `metaMemoryVerify` to see what already exists on the topic
2. review the related memories it returns
3. decide to upsert, delete, do both, or do nothing

Kody retrieves the related memories; the agent decides what they mean. Agents
should say what they saved — the value of memory is that you can see it move.

## Capabilities

All through `execute`:

- `metaMemoryVerify` — required first step before any write
- `metaMemoryUpsert` — create (no `memory_id`) or update (with `memory_id`)
- `metaMemoryDelete` — soft-delete by default; `force: true` deletes for good
- `metaMemoryGet` — load one memory by id
- `metaMemorySearch` — browse or search stored memories directly

Memories can carry optional `source_uris` — canonical document URLs such as a
GitHub file, an R2 object, or a Notion page — so a later agent can go to the
source.

## Your copy

You can download your memories as JSON from `/account/memories`. The file is
memories only: no credentials or other account primitives. Deleted memories are
included only when you turn on **Include deleted**.

## Where to go next

- [Connect your agent](./connect-your-agent.md) — Step 3 is a second agent
  reusing a memory the first one saved.
- [Email and memories](./first-win.md) — an optional playbook that turns a
  welcome-email reply into memories.
- [Memory and conversation context](../use/memory.md) — the MCP-level reference:
  `conversationId`, `memoryContext`, and retrieval behavior.
