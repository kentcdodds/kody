# 0033: No user-as-conversation, MCP session, or user-global memory hide

- **Status:** accepted
- **Date:** 2026-08-22

## Context

MCP revision `2026-07-28` is a stateless protocol: every request carries its
own `_meta`, servers **MUST NOT** infer context from prior requests on the same
connection, and servers **SHOULD** handle requests for multiple tasks, threads,
or conversations. An open connection or stdio process is not a conversation.
State that spans requests **MUST** be an explicit identifier the client
passes ([Statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness);
[0005](./0005-mcp-dual-lane-stateless-migration.md)).

Kody users talk to the same account from concurrent chats and from completely
separate agents. A memory shown in chat A must still be visible in chat B.

## Decision

Do not treat the signed-in user, an MCP transport session, or an open
connection as "the conversation." Do not add a user-global "already shown"
window for auto-surfaced memories.

Surface relevant memories on the tool result that retrieved them. The host
transcript is the conversation cache. Optional per-handle suppression stays
keyed to a `conversationId` the request actually carries (caller-supplied, or
a server-minted id later echoed). Hosts that omit the field every time get a
fresh mint and see the memories again.

Do not require a protocol conversation id in `_meta`. If a host later puts a
stable thread or run id there, use that handle; do not invent a session
stand-in.

## Consequences

Concurrent agents for one user stay isolated. Agents that never echo
`conversationId` may see the same top memories on each call — that is
correct. Revisit only if a major host ships a spec-defined conversation or
thread identifier that every request already carries.
