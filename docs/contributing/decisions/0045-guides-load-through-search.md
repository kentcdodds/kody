# 0045: Official guides load through search, not execute

- **Status:** accepted
- **Date:** 2026-09-01

## Context

Official guide markdown (`docs/guides/`) used to be discovered with `search` and
then read by executing `coding_guide_get`. That second hop spins up an isolate
for a bundled read. Search already has `{id}:{type}` entity detail for
capabilities, packages, secrets, and integrations.

Agents that follow MCP instructions and walkthroughs still paid execute cost
every time they opened a guide. The next agent would otherwise keep teaching
`execute` + `coding_guide_get` as the read path.

## Decision

Official guides are search entities. Ranked `search({ query })` can return
`{id}:guide` hits. `search({ entity: "{id}:guide" })` returns the full bundled
markdown. Do not add an execute-only path for reading official docs, and do not
tell agents to execute `coding_guide_get` just to load a guide.

`coding_guide_get` stays for execute-module code that needs the markdown body
programmatically.

## Consequences

- MCP instructions, usage docs, and interactive transcripts teach
  `search({ entity: "{id}:guide" })`.
- Guide ranking lives on the guide entities, not on a kitchen-sink keyword list
  on `coding_guide_get`.
- Unadvertised guides stay omitted from ranked listings and remain callable by
  exact entity id.
- Revisit only if search entity detail cannot return the full guide body (size
  budget or a host that cannot follow `{id}:guide` refs).
