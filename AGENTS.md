# kody agent index

Instructions for **agents and humans working in this repository** (building and
maintaining Kody). End-user / MCP usage docs live under
[`docs/use/`](./docs/use/index.md).

Kody is a multi-user personal assistant: every signed-in user gets a fully
isolated assistant (own packages, jobs, secrets, values, memories, remote
connectors, email inboxes, durable storage). When adding code, every read/write
path must be scoped by `userId`, every Durable Object id that backs user-owned
state must be namespaced by `userId`, and every search/vector path must filter
by `userId`. Cross-user data sharing is a bug.

Use Node 26 and npm for installs and scripts (`npm install`, `npm run ...`).

## Validation contract

`npm run validate` is the single authoritative local gate. It is read-only and
runs the same checks CI runs. CI splits those checks across parallel GitHub
Actions jobs (static, node unit, workers unit, MCP E2E, Playwright E2E) so heavy
suites do not contend on one runner; the ✅ Validate job aggregates them. If
`npm run validate` passes locally, CI will pass; if CI fails despite a green
local `validate`, that is a bug and should be filed.

- `npm run validate` runs `format:check`, `lint`, `typecheck`, unit tests,
  Playwright E2E, MCP E2E, `backup:build`, and repository structure checks
  (`primitives:check` and `migrations:check`) in parallel and reports every
  failure (it does not abort sibling checks on the first failure).
- `npm run validate:fix` is the explicit opt-in for mutating auto-fixes
  (`format` + `lint:fix`). Running it is never required to pass `validate`.
- The Husky `pre-commit` and `pre-push` hooks remain narrower fast gates; they
  are not a substitute for `validate`.

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
- Enforced app / MCP / shared-primitive import layering:
- [docs/contributing/import-boundaries.md](./docs/contributing/import-boundaries.md)
- Testing guidance:
  - [docs/contributing/testing-principles.md](./docs/contributing/testing-principles.md)
  - [docs/contributing/end-to-end-testing.md](./docs/contributing/end-to-end-testing.md)
- Tooling and framework references:
  - [docs/contributing/harness-engineering.md](./docs/contributing/harness-engineering.md)
  - [docs/contributing/oxlint-js-plugins.md](./docs/contributing/oxlint-js-plugins.md)
- [docs/contributing/remix.md](./docs/contributing/remix.md) and the repo-local
  [Remix skill](./.agents/skills/remix/SKILL.md)
- [docs/contributing/cloudflare-agents-sdk.md](./docs/contributing/cloudflare-agents-sdk.md)
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
- PR system recaps (visual plan/recap blocks in PR descriptions):
  - [.agents/skills/visual-recap/SKILL.md](./.agents/skills/visual-recap/SKILL.md)
  - [docs/contributing/architecture/primitives.yaml](./docs/contributing/architecture/primitives.yaml)
    (stable taxonomy — classify with `npm run primitives:classify`, check with
    `npm run primitives:check`; do not treat the map as a feature changelog)

## Cursor Cloud-specific instructions

Cloud Agent VM gotchas (Node 26 on `PATH`, the Playwright browser-install hang
and manual workaround, dev server, seeding, and local limitations) live in a
dedicated reference:

- [Cursor Cloud Agent notes](./docs/contributing/cloud-agents.md)
