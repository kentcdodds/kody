# Memory and conversation context

**Work in progress.** Kody’s MCP tools accept optional **`conversationId`** and
**`memoryContext`** fields.

**`conversationId`** ties related tool calls together. Omit it on the first call
to receive a server-generated id, then pass the returned id on follow-up calls
in the same conversation.

**`memoryContext`** is reserved for **future memory-aware behavior**. It is
**not** persisted or used for retrieval yet. Keep it short and task-focused when
you set it so future versions can build on consistent patterns.

This page expands when memory features ship. See [First steps](./first-steps.md)
for current behavior that already helps (reusing **`conversationId`**).
