# Documentation

This repository maintains two audiences:

- **[`docs/use/`](../use/index.md)** — People who connect an agent to Kody over
  MCP. Progressive disclosure: short pages linked from the usage index.
- **`docs/contributing/`** — People who develop Kody (code, kody, infra).

## Principles

**Describe how things work.** Write in the present tense. Avoid changelog-style
phrases (“now we…”, “we no longer…”, “previously…”) in both usage and
contributing docs; those belong in commit messages or release notes. Describe
the system as it works today (“Kody stores…”, “The manifest rejects…”) instead
of narrating a rollout (“Kody now stores…”, “We no longer accept…”).

Docs-like product copy follows the same rule: MCP server instructions, tool and
schema descriptions, and user-visible UI strings should not read like release
notes.

**Exceptions.** Migration and rotation guides (for example
[`secret-rotation.md`](./secret-rotation.md)) may use ordered steps across
deploy phases. Outside those procedures, still describe the current design in
plain language. Quoted validation errors and runtime messages should match what
the product returns, even when the wording contrasts with older manifest shapes.

**Stay lightweight but valuable.** Prefer small, accurate pages over large stale
ones. **Garden** docs when behavior changes: update or delete sections in the
same change as the code when possible. Remove duplication between pages by
linking out instead of copying paragraphs.

**MCP instructions and tool descriptions stay tight.** Server-level instructions
and per-tool descriptions should give the model what it needs **before**
choosing or invoking a tool: workflows, constraints, and **copy-pasteable
examples**. Long policy lists and exhaustive field semantics belong in **usage
docs** or in **tool responses** (structured content, error text, and follow-up
messages), not in the instruction string.

**Put post-call detail in the call result.** Anything the model only needs
**after** a tool runs (full schemas on demand, ranked hit lists, approval URLs,
error bodies) should surface from the **tool response**, not from static
instructions. Static text should not repeat large chunks of what the user or
model will see in the next response.

**Avoid overlap with generated surfaces.** If the MCP host already shows tool
schemas or resource listings, documentation and instructions should not restate
the same tables verbatim; link to usage docs or rely on the tool output.

## Related

- [MCP server patterns](./mcp-server-patterns.md) — tool descriptions, schemas,
  and server instructions
- [Usage index](../use/index.md) — end-user table of contents
