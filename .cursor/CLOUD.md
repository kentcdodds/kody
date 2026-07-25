# kody Cloud Agent Guide

A full-stack web application built on Cloudflare Workers with Remix 3 (beta).

## Quick Reference

| Task                   | Command                |
| ---------------------- | ---------------------- |
| Start dev server       | `npm run dev`          |
| Full validation        | `npm run validate`     |
| Apply formatter / lint | `npm run validate:fix` |
| Lint                   | `npm run lint`         |
| Format                 | `npm run format`       |
| Type check             | `npm run typecheck`    |
| Build                  | `npm run build`        |
| E2E tests              | `npm run test:e2e:run` |

`npm run validate` is the single authoritative local gate. CI runs the same
checks as parallel jobs (including separate 🧪 Node and ☁️ Workers unit jobs),
so a green local `validate` means CI will pass. `validate` is read-only; use
`npm run validate:fix` when you want auto-fixes applied.

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
- [.agents/skills/remix/SKILL.md](../.agents/skills/remix/SKILL.md) - Remix
  skill
- [docs/contributing/setup.md](../docs/contributing/setup.md) - Setup
  documentation
- [docs/contributing/testing-principles.md](../docs/contributing/testing-principles.md) -
  Testing guidelines
- [docs/contributing/end-to-end-testing.md](../docs/contributing/end-to-end-testing.md) -
  E2E testing guide
