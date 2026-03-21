<div align="center">
  <img src="./public/logo.png" alt="kody logo" width="400" />

  <p>
    <strong>An experimental personal assistant platform built on Cloudflare Workers and MCP</strong>
  </p>

  <p>
    <a href="https://github.com/epicweb-dev/epicflare/actions/workflows/deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/epicweb-dev/epicflare/deploy.yml?branch=main&style=flat-square&logo=github&label=CI" alt="Build Status" /></a>
    <img src="https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Bun-run-f9f1e1?style=flat-square&logo=bun&logoColor=white" alt="Bun" />
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
    <img src="https://img.shields.io/badge/Remix-3.0_alpha-000000?style=flat-square&logo=remix&logoColor=white" alt="Remix" />
  </p>
</div>

---

`kody` is currently an experiment in building a personal assistant that can work
across AI agent hosts that support MCP.

Today this repo includes a Remix-powered UI, Cloudflare Worker request routing,
chat-agent plumbing, and OAuth-protected MCP endpoints. The long-term direction
is not a huge static tool catalog. It is a compact MCP surface with broader
capabilities hidden behind a compact `search` tool plus Code Mode `execute`
flows.

This project is intentionally single-user right now and is being built for
`me@kentcdodds.com`.

The repo is organized as an Nx monorepo, with shared modules in
`packages/shared` (`@kody-internal/shared`), the main app worker under
`packages/worker`, and mock Workers under `packages/mock-servers/*`.

## Quick Start

```bash
bunx create-epicflare
```

This will clone the template, install dependencies, run the guided setup, and
start the dev server.

See [`docs/getting-started.md`](./docs/getting-started.md) for the full setup
paths and expectations.

If you are trying to understand what this repository is for, start with
[`docs/project-intent.md`](./docs/project-intent.md).

## Tech Stack

| Layer           | Technology                                                            |
| --------------- | --------------------------------------------------------------------- |
| Runtime         | [Cloudflare Workers](https://workers.cloudflare.com/)                 |
| UI Framework    | [Remix 3](https://remix.run/) (alpha)                                 |
| Package Manager | [Bun](https://bun.sh/)                                                |
| Workspace       | [Nx](https://nx.dev/) + Bun workspaces                                |
| Database        | [Cloudflare D1](https://developers.cloudflare.com/d1/)                |
| Session/OAuth   | [Cloudflare KV](https://developers.cloudflare.com/kv/)                |
| MCP State       | [Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| E2E Testing     | [Playwright](https://playwright.dev/)                                 |
| Bundler         | [esbuild](https://esbuild.github.io/)                                 |

## Current Scope

- Personal assistant experiment, not a multi-tenant SaaS product
- MCP-first architecture intended to work across compatible AI agent hosts
- Compact MCP surface area preferred over a large static tool inventory
- ChatGPT is a likely primary host target, while keeping the server usable from
  other MCP hosts where practical

## How It Works

```
Request → packages/worker/src/index.ts
              │
              ├─→ OAuth handlers
              ├─→ MCP endpoints
              ├─→ Static assets (public/)
              └─→ Server router → Remix components
```

- `packages/worker/src/index.ts` is the entrypoint for Cloudflare Workers
- OAuth requests are handled first, then MCP requests, then static assets
- Non-asset requests fall through to the server handler and router
- Client assets are bundled into `public/` and served via the `ASSETS` binding

## Documentation

| Document                                                           | Description                          |
| ------------------------------------------------------------------ | ------------------------------------ |
| [`docs/getting-started.md`](./docs/getting-started.md)             | Setup, environment variables, deploy |
| [`docs/environment-variables.md`](./docs/environment-variables.md) | Adding new env vars                  |
| [`docs/cloudflare-offerings.md`](./docs/cloudflare-offerings.md)   | Optional Cloudflare integrations     |
| [`docs/project-intent.md`](./docs/project-intent.md)               | Scope, goals, and non-goals          |
| [`docs/agents/setup.md`](./docs/agents/setup.md)                   | Local development and verification   |

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://epicweb.dev">Epic Web</a></sub>
</div>
