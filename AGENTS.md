# kody agent index

Kody is a multi-user personal assistant: every signed-in user gets a fully
isolated assistant (own packages, jobs, secrets, values, memories, remote
connectors, email inboxes, durable storage).

`npm run validate` is the single authoritative local gate.

This file is intentionally brief. Detailed instructions live in focused docs:

- Contributor documentation map:
  - [docs/contributing/index.md](./docs/contributing/index.md)
- Project intent and scope:
  [docs/contributing/project-intent.md](./docs/contributing/project-intent.md)
- Decision records (check before proposing something already decided against):
  [docs/contributing/decisions/index.md](./docs/contributing/decisions/index.md)
- Setup, checks, docs maintenance, preview deploys, and seeding:
  - [docs/contributing/setup.md](./docs/contributing/setup.md)
- Manual PR preview testing (medium/high risk, logged-in user + data):
  - [docs/contributing/preview-manual-testing.md](./docs/contributing/preview-manual-testing.md)
    and the
    [preview-manual-test skill](./.agents/skills/preview-manual-test/SKILL.md)
- Documentation principles (usage vs contributing, MCP text, gardening):
  - [docs/contributing/documentation.md](./docs/contributing/documentation.md)
- Code style conventions:
  - [docs/contributing/code-style.md](./docs/contributing/code-style.md)
- Enforced app / MCP / worker / universal import layering:
  [docs/contributing/import-boundaries.md](./docs/contributing/import-boundaries.md)
- Testing guidance:
  - [docs/contributing/testing-principles.md](./docs/contributing/testing-principles.md)
  - [docs/contributing/end-to-end-testing.md](./docs/contributing/end-to-end-testing.md)
- Tooling and framework references:
  - [docs/contributing/harness-engineering.md](./docs/contributing/harness-engineering.md)
  - [docs/contributing/oxlint-js-plugins.md](./docs/contributing/oxlint-js-plugins.md)
  - [docs/contributing/remix.md](./docs/contributing/remix.md) and the
    repo-local [Remix skill](./.agents/skills/remix/SKILL.md)
  - [docs/contributing/cloudflare-agents-sdk.md](./docs/contributing/cloudflare-agents-sdk.md)
- MCP capabilities (search/execute graph, domains, registry):
  - [docs/contributing/adding-capabilities.md](./docs/contributing/adding-capabilities.md)
- Project setup references:
  - [docs/contributing/getting-started.md](./docs/contributing/getting-started.md)
  - [docs/contributing/environment-variables.md](./docs/contributing/environment-variables.md)
  - [docs/contributing/setup-manifest.md](./docs/contributing/setup-manifest.md)
- Architecture references:
  - [docs/contributing/architecture/index.md](./docs/contributing/architecture/index.md)
    (request lifecycle, authentication, data storage, and the rest of the
    architecture leaves)
  - [docs/contributing/architecture/primitives.yaml](./docs/contributing/architecture/primitives.yaml)
    (stable taxonomy, not a feature changelog — see the architecture index for
    the classify/check workflow)
- PR system recaps (visual plan/recap blocks in PR descriptions):
  - [.agents/skills/visual-recap/SKILL.md](./.agents/skills/visual-recap/SKILL.md)

## Cursor Cloud-specific instructions

Cloud Agent VM gotchas (Node 26 on `PATH`, the Playwright browser-install hang
and manual workaround, dev server, seeding, and local limitations) live in a
dedicated reference:

- [Cursor Cloud Agent notes](./docs/contributing/cloud-agents.md)
