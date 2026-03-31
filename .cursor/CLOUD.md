# kody Cloud Agent Guide

A full-stack web application starter built on Cloudflare Workers with Remix 3
(alpha).

## Quick Reference

| Task             | Command                |
| ---------------- | ---------------------- |
| Start dev server | `npm run dev`          |
| Full validation  | `npm run validate`     |
| Lint             | `npm run lint`         |
| Format           | `npm run format`       |
| Type check       | `npm run typecheck`    |
| Build            | `npm run build`        |
| E2E tests        | `npm run test:e2e:run` |

## Services

- **Dev server**: Runs at `localhost:8787` (Cloudflare Workers local)
- `npm run dev` starts both the client esbuild watcher and Wrangler worker
  server

## Architecture

- **Server**: Cloudflare Workers (see `packages/worker/src/`)
- **Client**: Remix 3 components bundled with esbuild (see
  `packages/worker/client/`)
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
