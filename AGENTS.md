# kody agent index

Kody is a multi-user personal assistant: every signed-in user gets a fully
isolated assistant (own packages, jobs, secrets, memories, remote connectors,
email inboxes, durable storage).

`npm run validate` is the single authoritative local gate.

This file is a map, not the docs. Open the page that owns the task:

- Contributor documentation map:
  [docs/contributing/index.md](./docs/contributing/index.md)
- Task skills: [`.agents/skills/`](./.agents/skills/)
- Line budget: `npm run file-size-ratchet:check` (`agents-md`)

## Cursor Cloud-specific instructions

Cloud Agent VM gotchas (Node on `PATH`, Playwright install, dev server, seeding,
local limitations):
[docs/contributing/cloud-agents.md](./docs/contributing/cloud-agents.md)
