# 0072 — Memory is personal-only

- **Status:** accepted
- **Date:** 2026-10-14

## Context

Every memory row is keyed by an `OwnerId` (org id). MCP memory tools used
`ownerIdFromCaller` (the connection's org), so a team-org connection read and
wrote the team pool, while auto-surface already searched only
`personalOrgId(person)` ([0033](./0033-memory-auto-surface-lab.md),
[0060](./0060-owner-and-person-ids.md), [0064](./0064-oauth-org-binding.md)).
Docs said memory follows the person; tools disagreed. Role presets give plain
members no `memory:*`, so the team pool was effectively owners-only, and agents
could still misfile private facts into a shared pool or copy personal recall
into org packages.

Research across peer products (Option A): automatic memory stays personal;
shared knowledge lives in human-curated instructions, files, or skills — for
Kody, documented packages and org instructions.

## Decision

**Memory is personal-only.** One writable pool per person: their personal org.
MCP memory tools always authorize and store against that personal org,
regardless of which org the OAuth/CLI connection is bound to. Auto-surface
labels recalled memories as personal and tells agents to ask before copying them
into an org package. Shared org knowledge is **not** memory — it belongs in
documented packages and org instructions.

We do **not**:

- add team, org-wide, or user-in-org writable memory scopes
- let agents choose a memory scope on write
- create new `resource_type: memory` grants on non-personal orgs

**Migration:** copy each live team-org memory to every person with effective
`memory:read` on that memory at snapshot time (owners, org-wide `memory:read`
grantees, per-memory user/team grant subjects). Skip when the personal org
already has identical subject+summary+details; otherwise insert with a
provenance `source_uri`. Originals stay on the team org, write-frozen, until a
follow-up cleanup verifies copies and removes (or hides) the legacy list. Team
`/@slug/-/memories` is a read-only legacy view for the soak.

## Consequences

Agents stop filing into the wrong pool. The split-brain between tools and
auto-surface ends. Org packages remain the progressive-discovery home for shared
knowledge. Revisit only if orgs repeatedly need short shared facts that do not
belong in any package — then consider human-approved org notes (Option B), not
agent-written org memory.
