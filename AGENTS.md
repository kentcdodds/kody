# kody agent index

Instructions for **agents and humans working in this repository** (building and
maintaining Kody). End-user / MCP usage docs live under
[`docs/use/`](./docs/use/index.md).

Use Node 24 and npm for installs and scripts (`npm install`, `npm run ...`).

This file is intentionally brief. Detailed instructions live in focused docs:

- Contributor documentation map:
  [docs/contributing/index.md](./docs/contributing/index.md)
- Talk slide decks (Slidev): [docs/talks/README.md](./docs/talks/README.md)
  (`npm run dev:talks`)
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


## Cursor Cloud specific instructions

| Task | Command |
| ---------------- | ---------------------- |
| Start dev server | `npm run dev` |
| Full validation | `npm run validate` |
| Lint | `npm run lint` |
| Format | `npm run format` |
| Type check | `npm run typecheck` |
| Build | `npm run build` |
| E2E tests | `npm run test:e2e:run` |

### Services

- **Dev server**: `npm run dev` starts all services (worker at `localhost:3742`,
  mock AI, mock Cloudflare API, client bundle watcher, and home connector at
  `localhost:4040`). No external services required.
- D1 (SQLite), KV, and Durable Objects are emulated locally by Wrangler.

### Non-obvious caveats

- The seed script needs an explicit config path:
  `node tools/seed-test-data.ts --local --config packages/worker/wrangler.jsonc`
  (without `--config` it fails to find the D1 binding).
- `packages/worker/.env` must exist before `npm run dev`. Copy from
  `.env.example` if missing: `cp packages/worker/.env.example packages/worker/.env`
- Migrations: `npm run migrate:local` before first dev run or after schema
  changes.
- Test credentials: `me@kentcdodds.com` / `iliketwix` (seeded via
  `node tools/seed-test-data.ts --local --config packages/worker/wrangler.jsonc`).
- The MCP endpoint at `/mcp` requires OAuth; unauthenticated requests return 401
  with proper OAuth metadata. This is expected behavior.
- The `pre-commit` hook runs `lint-staged` + `typecheck`; the `pre-push` hook
  runs `npm run test:push` (vitest + Playwright E2E). Disable hooks with
  `--no-verify` when needed for intermediate commits.
