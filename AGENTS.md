# kody agent index

Use Bun for installs and scripts (`bun install`, `bun run ...`). Do not use npm.

This file is intentionally brief. Detailed instructions live in focused docs:

- Project intent and scope:
  - [docs/project-intent.md](./docs/project-intent.md)
- Setup, checks, docs maintenance, preview deploys, and seeding:
  - [docs/agents/setup.md](./docs/agents/setup.md)
- Code style conventions:
  - [docs/agents/code-style.md](./docs/agents/code-style.md)
- Testing guidance:
  - [docs/agents/testing-principles.md](./docs/agents/testing-principles.md)
  - [docs/agents/end-to-end-testing.md](./docs/agents/end-to-end-testing.md)
- Tooling and framework references:
  - [docs/agents/harness-engineering.md](./docs/agents/harness-engineering.md)
  - [docs/agents/oxlint-js-plugins.md](./docs/agents/oxlint-js-plugins.md)
  - [docs/agents/remix/index.md](./docs/agents/remix/index.md)
  - [docs/agents/cloudflare-agents-sdk.md](./docs/agents/cloudflare-agents-sdk.md)
  - [docs/agents/mcp-apps-starter-guide.md](./docs/agents/mcp-apps-starter-guide.md)
- Project setup references:
  - [docs/getting-started.md](./docs/getting-started.md)
  - [docs/environment-variables.md](./docs/environment-variables.md)
  - [docs/setup-manifest.md](./docs/setup-manifest.md)
- Architecture references:
  - [docs/architecture/index.md](./docs/architecture/index.md)
  - [docs/architecture/request-lifecycle.md](./docs/architecture/request-lifecycle.md)
  - [docs/architecture/authentication.md](./docs/architecture/authentication.md)
  - [docs/architecture/data-storage.md](./docs/architecture/data-storage.md)

## Cursor Cloud specific instructions

# kody Cloud Agent Guide

A full-stack web application starter built on Cloudflare Workers with Remix 3
(alpha).

## Quick Reference

| Task             | Command             |
| ---------------- | ------------------- |
| Start dev server | `bun run dev`       |
| Full validation  | `bun run validate`  |
| Lint             | `bun run lint`      |
| Format           | `bun run format`    |
| Type check       | `bun run typecheck` |
| Build            | `bun run build`     |
| E2E tests        | `bun run test:e2e`  |

## Services

- **Dev server**: Runs at `localhost:3742` (Cloudflare Workers local)
- `bun run dev` starts both the client esbuild watcher and Wrangler worker
  server

## Architecture

- **Server**: Cloudflare Workers (see `worker/` and `server/`)
- **Client**: Remix 3 components bundled with esbuild (see `client/`)
- **Database**: Cloudflare D1 (SQLite, auto-handled locally by Wrangler)
- **MCP Server**: Available at `/mcp` endpoint when worker runs

## Documentation

- [AGENTS.md](../AGENTS.md) - Agent instructions and verification steps
- [docs/agents/remix/index.md](../docs/agents/remix/index.md) - Remix package
  docs
- [docs/agents/setup.md](../docs/agents/setup.md) - Setup documentation
- [docs/agents/testing-principles.md](../docs/agents/testing-principles.md) -
  Testing guidelines
- [docs/agents/end-to-end-testing.md](../docs/agents/end-to-end-testing.md) -
  E2E testing guide
