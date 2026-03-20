# kody Cloud Agent Guide

A full-stack web application starter built on Cloudflare Workers with Remix 3
(alpha).

## Maintainer note

Cursor Cloud agent definitions/instructions live in this file. When changing
Kody's Cursor Cloud agent behavior, update `.cursor/CLOUD.md` and keep
`AGENTS.md` as the brief index. Add deeper guidance in `docs/agents` when
needed.

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

- **Dev server**: Runs at `localhost:8787` (Cloudflare Workers local)
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
