# kody agent index

Instructions for **agents and humans working in this repository** (building and
maintaining Kody). End-user / MCP usage docs live under
[`docs/use/`](./docs/use/index.md).

Kody is a multi-user personal assistant: every signed-in user gets a fully
isolated assistant (own packages, jobs, secrets, values, memories, chat threads,
remote connectors, email inboxes, durable storage). When adding code, every
read/write path must be scoped by `userId`, every Durable Object id that backs
user-owned state must be namespaced by `userId`, and every search/vector path
must filter by `userId`. Cross-user data sharing is a bug.

Use Node 26 and npm for installs and scripts (`npm install`, `npm run ...`).

## Validation contract

`npm run validate` is the single authoritative gate. It is read-only and runs
the same checks CI runs — in fact CI invokes `npm run validate` literally. If
`npm run validate` passes locally, CI will pass; if CI fails despite a green
local `validate`, that is a bug in `validate` and should be filed.

- `npm run validate` runs `format:check`, `lint`, `typecheck`, unit tests,
  Playwright E2E, and MCP E2E in parallel and reports every failure (it does not
  abort sibling checks on the first failure).
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
- PR system recaps (visual plan/recap blocks in PR descriptions):
  - [.agents/skills/visual-recap/SKILL.md](./.agents/skills/visual-recap/SKILL.md)
  - [docs/contributing/architecture/primitives.yaml](./docs/contributing/architecture/primitives.yaml)

## Cursor Cloud-specific instructions

Kody is a single Cloudflare Workers app (Remix 3 UI + OAuth-protected MCP). See
[`docs/contributing/setup.md`](./docs/contributing/setup.md) for the full local
dev guide; this section covers Cloud Agent VM gotchas only.

### Node 26

The repo requires Node **>=26** (`engines` in root `package.json`). Cloud Agent
VMs may ship Node 22 at `/exec-daemon/node`, which takes precedence over nvm
unless nvm’s Node 26 bin directory is prepended to `PATH`. Verify with
`node --version` before running scripts.

### Quick commands

| Task             | Command                                                         |
| ---------------- | --------------------------------------------------------------- |
| Install deps     | `npm install`                                                   |
| Start dev        | `npm run dev` (prints the resolved URL)                         |
| Migrate local D1 | `npm run migrate:local`                                         |
| Seed test login  | `node tools/seed-test-data.ts --local` (see seeding note below) |
| Full CI gate     | `npm run validate`                                              |

### Dev server

- `npm run dev` starts the client esbuild watcher, optional Cloudflare API mock
  worker, and the main worker with local D1/KV/DO persistence.
- Default worker port is **3742** (`cli.ts`); the CLI picks a free port when
  3742 is taken and prints `App running at http://localhost:<port>`.
- Run long-lived dev in tmux so the session survives tool timeouts.
- Health check (no auth): `curl http://localhost:<port>/health` →
  `{"ok":true,"commitSha":...}`.

### Environment file

Copy `packages/worker/.env.example` to `packages/worker/.env` if missing.
`COOKIE_SECRET` and `SECRET_STORE_KEY` are required for local dev.

### Seeding a test account

After `npm run migrate:local`, seed the local fixture logins per
[`docs/contributing/setup.md`](./docs/contributing/setup.md): `kody@example.com`
/ `ilikecode` (seeded with the `admin` role) and `jane@example.com` /
`ilikecode` (regular account). These credentials are local test fixtures only.
The seed script resolves the worker Wrangler config automatically (same default
as `wrangler-env.ts`), so `node tools/seed-test-data.ts --local` works without
extra flags.

### Local limitations

- Vectorize bindings are not emulated locally; capability search uses the
  offline ranker when `WRANGLER_IS_LOCAL_DEV` is set (normal for `npm run dev`).
- `/mcp` returns **401** without OAuth; use browser login or MCP E2E tests for
  authenticated MCP checks.
