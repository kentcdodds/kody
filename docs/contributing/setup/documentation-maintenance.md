# Documentation maintenance

How contributor and usage docs stay current. See the [setup index](./index.md)
for the other setup pages.

- Read [`project-intent.md`](../project-intent.md) before making product-level
  changes or writing docs that describe the project's goals.
- Follow [Documentation principles](../documentation.md) for usage docs, MCP
  instruction text, and contributing guides (lightweight pages, current
  behavior, post-tool detail in responses).
- Update `docs/guides/` when a served docs page changes. Update `docs/use/` when
  MCP field-reference behavior changes. A `docs/use` stub only points at the
  guide. Update `docs/contributing` when contributor workflows, architecture
  notes, or verification guidance change.
- Treat docs updates as part of done work.
- Keep `AGENTS.md` concise and index-like; put details in focused docs. The
  `agents-md` file-size ratchet (`npm run file-size-ratchet:check`) holds the
  line budget.
- When failures repeat, promote lessons from docs into tests, lint rules, or
  scripts.
