# kody agent index

Instructions for **agents and humans working in this repository** (building and
maintaining Kody). End-user / MCP usage docs live under
[`docs/use/`](./docs/use/index.md).

Use Node 24 and npm for installs and scripts (`npm install`, `npm run ...`).

This file is intentionally brief. Detailed instructions live in focused docs:

- Contributor documentation map:
  [docs/contributing/index.md](./docs/contributing/index.md)
- Documentation principles (usage vs contributing, MCP text, gardening):
  [docs/contributing/documentation.md](./docs/contributing/documentation.md)
- Commit-time formatting, linting, and typechecking are enforced by Husky +
  lint-staged; see `docs/contributing/setup.md` for the workflow details and
  what needs explicit validation.

- Project intent and scope:
  - [docs/contributing/project-intent.md](./docs/contributing/project-intent.md)
- Setup, checks, docs maintenance, preview deploys, and seeding:
  - [docs/contributing/setup.md](./docs/contributing/setup.md)
- Code style conventions:
  - [docs/contributing/code-style.md](./docs/contributing/code-style.md)
- Testing guidance:
  - [docs/contributing/testing-principles.md](./docs/contributing/testing-principles.md)
  - [docs/contributing/end-to-end-testing.md](./docs/contributing/end-to-end-testing.md)
- Tooling and framework references:
  - [docs/contributing/harness-engineering.md](./docs/contributing/harness-engineering.md)
  - [docs/contributing/oxlint-js-plugins.md](./docs/contributing/oxlint-js-plugins.md)
- [docs/contributing/remix.md](./docs/contributing/remix.md) and the repo-local
  [Remix skill](./.agents/skills/remix/SKILL.md)
- [docs/contributing/cloudflare-agents-sdk.md](./docs/contributing/cloudflare-agents-sdk.md)
- [docs/contributing/mcp-apps-spec-notes.md](./docs/contributing/mcp-apps-spec-notes.md)
- MCP capabilities (search/execute graph, domains, registry):
  - [docs/contributing/adding-capabilities.md](./docs/contributing/adding-capabilities.md)
- Project setup references:
  - [docs/contributing/getting-started.md](./docs/contributing/getting-started.md)
  - [docs/contributing/environment-variables.md](./docs/contributing/environment-variables.md)
  - [docs/contributing/setup-manifest.md](./docs/contributing/setup-manifest.md)
- Architecture references:
  - [docs/contributing/architecture/index.md](./docs/contributing/architecture/index.md)
  - [docs/contributing/architecture/request-lifecycle.md](./docs/contributing/architecture/request-lifecycle.md)
  - [docs/contributing/architecture/authentication.md](./docs/contributing/architecture/authentication.md)
  - [docs/contributing/architecture/data-storage.md](./docs/contributing/architecture/data-storage.md)
