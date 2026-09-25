---
id: agent_guidance
title: Where agent guidance lives
summary:
  Progressive disclosure for agent guidance across MCP server instructions,
  package docs (README.md and AGENTS.md), export JSDoc, and memories. Load this
  when deciding where a fact or instruction should live, or before calling
  metaMemoryUpsert or metaSetMcpServerInstructions. Search phrases such as
  "where should this guidance live" should find this page.
category: platform
---

# Where agent guidance lives

Agents keep stuffing specifics into the wrong layer: MCP server instructions,
memories, package docs, or export JSDoc. Put guidance at the **lowest layer that
still reaches the agents who need it**, and keep higher layers thin. This page
is the decision guide.

Before you call `metaMemoryUpsert` or `metaSetMcpServerInstructions`, open this
guide (`search({ entity: "guide:agent_guidance" })` or `/docs/agent-guidance`).
If the fact is package- or export-scoped, edit the package instead.

## The four layers

| Layer                                                                                                       | Reaches                                                       | Put here                                                                                                            | Do not put here                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **MCP server instructions** (built-in fragments + optional user overlay via `metaSetMcpServerInstructions`) | Every conversation on new MCP sessions                        | Short, general nudges: prefer `search`, verify-first memory, escalate `execute` to packages                         | Package inventory, export gotchas, account-specific durable facts, long runbooks                      |
| **Package documentation** (`README.md` human / `AGENTS.md` agent)                                           | Agents (and people) working on or invoking that package       | Intent, how pieces fit, workflows, staging or upload steps, smoke tests, edge cases that apply to the whole package | Account preferences, which cloud account owns what, one-export call limits that belong on that export |
| **JSDoc on exports**                                                                                        | Agents reading search Purpose / entity detail for that export | Call shape specifics, limits, when to pick this export over a sibling                                               | Package-wide workflows, durable user facts, always-on session policy                                  |
| **Memories**                                                                                                | Agents on this account via search/execute auto-surface        | Durable facts not tied to one package or export: preferences, identifiers, which account owns which resources       | How a package moves bytes, export body format limits, credential values (use [secrets](./secrets.md)) |

Higher layers appear more often and cost more context. Lower layers stay close
to the code or fact they describe. Prefer the lowest layer that still works.

## Decision checklist

Ask in order:

1. **Is this about one export?** Put it in that export's JSDoc. Search Purpose
   comes from JSDoc
   ([Package authoring — Export JSDoc](./package-authoring.md#export-jsdoc)).
2. **Is this about one package's intent, workflow, or agent runbook?** Put it in
   `README.md` and/or `AGENTS.md`
   ([Package authoring — Package docs](./package-authoring.md#package-docs-readme.md-agents.md)).
3. **Is this a durable fact about the person or account, not about a package?**
   Put it in [memory](./memory.md) (`metaMemoryVerify` then `metaMemoryUpsert`).
4. **Is this rare always-on session policy that every conversation must see?**
   Only then consider the MCP overlay (`metaGetMcpServerInstructions` /
   `metaSetMcpServerInstructions`). Prefer memories for durable facts; keep the
   overlay short. Built-in fragments already cover search-first and lifecycle
   conventions.

If step 1 or 2 applies, do **not** upsert a memory and do **not** extend the MCP
overlay. Update the package.

## Concrete examples (generic)

**MCP server instructions (good):** "When blocked on credentials or access,
`search` Kody for waiting state and the relevant integration or secret docs."

**MCP server instructions (bad):** Listing every package the account uses, or
copying an export's JSON-only body limit into the overlay.

**Package docs (good):** How to stage an upload, which files to touch for a
common workflow, smoke-test calls for the package as a whole.

**Package docs (bad):** "This user's Cloudflare account id is …" or "always
prefer JSON over binary for export X" when only that export has the limit.

**Export JSDoc (good):** "Accepts a JSON body only; for raw binary use `fetch`
against the returned URL." Or "Call this when you need a preview; use `commit`
when ready to publish."

**Export JSDoc (bad):** Repeating the whole package Intent, or storing the
user's preferred timezone.

**Memory (good):** Preferred review style, handles and ids the person reuses,
which cloud or billing account owns which resources.

**Memory (bad):** "Package foo's upload flow is …" or "Export bar rejects binary
bodies." Those belong in package docs or JSDoc so every consumer of the package
sees them without depending on one account's memories.

## Built-in MCP instructions and the user overlay

Every MCP session gets short built-in fragments (overview, quick start, package
lifecycle, conventions, domains). They mostly encourage `search` rather than
listing specifics. Popular packages may be hinted automatically; do not paste
package inventory into the user overlay.

The optional overlay from `metaSetMcpServerInstructions` appends to those
fragments for **new** sessions. Use it only for rare always-on session policy.
Prefer [memories](./memory.md) for durable facts and preferences. Overlay
updates do not rewrite a host that already cached server instructions; reconnect
if needed.

## Writing guidance: do this first

1. Open `guide:agent_guidance` (this page) when unsure which layer fits.
2. If the candidate is package- or export-scoped, edit `README.md` / `AGENTS.md`
   or export JSDoc, then publish. Skip memory upsert and MCP overlay set.
3. If it is an account-level durable fact, run `metaMemoryVerify`, then upsert
   only after review ([Shared memory](./memory.md)).
4. If it is rare session policy, read the current overlay with
   `metaGetMcpServerInstructions`, keep it short, and set only what must appear
   in every conversation.

## Where to go next

- [Shared memory](./memory.md) — what belongs in memory and the verify-first
  write path.
- [Package authoring](./package-authoring.md) — README / AGENTS.md and Export
  JSDoc contracts.
- [Search and execute](./search-and-execute.md) — how agents discover guides and
  package detail.
- [Packages, integrations, and MCP servers](./packages-integrations-mcp.md) —
  keep those three surfaces from collapsing into each other.
