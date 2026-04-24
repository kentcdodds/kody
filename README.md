<div align="center">
  <img src="./packages/worker/public/logo.png" alt="kody logo" width="400" />

  <p>
    <strong>An experimental personal assistant platform built on Cloudflare Workers and MCP</strong>
  </p>

  <p>
    <a href="https://github.com/epicweb-dev/epicflare/actions/workflows/deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/epicweb-dev/epicflare/deploy.yml?branch=main&style=flat-square&logo=github&label=CI" alt="Build Status" /></a>
    <img src="https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Node-24-5FA04E?style=flat-square&logo=node.js&logoColor=white" alt="Node 24" />
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
    <img src="https://img.shields.io/badge/Remix-3.0_alpha-000000?style=flat-square&logo=remix&logoColor=white" alt="Remix" />
  </p>
</div>

---

`kody` is an experimental personal assistant platform built on Cloudflare
Workers and the Model Context Protocol (MCP). It ships a Remix UI, Worker-based
request routing, chat-agent plumbing, and OAuth-protected MCP endpoints. The
project favors a compact MCP surface with powerful `search` and Code Mode
`execute` flows over a large static tool catalog.

This project is intentionally single-user and is being built for
`me@kentcdodds.com`. The repo is based on the
[epicflare](https://github.com/epicweb-dev/epicflare) starter.

The repo is organized as an Nx monorepo, with shared modules in
`packages/shared` (`@kody-internal/shared`), the main app worker under
`packages/worker`, and mock Workers under `packages/mock-servers/*`.

## Quick Start

```bash
npx create-epicflare
```

This will clone the template, install dependencies, run the guided setup, and
start the dev server.

See
[`docs/contributing/getting-started.md`](./docs/contributing/getting-started.md)
for the full setup paths and expectations. Contributors and agents should start
with [`AGENTS.md`](./AGENTS.md) for repo-specific guidance.

If you are trying to understand what this repository is for, start with
[`docs/contributing/project-intent.md`](./docs/contributing/project-intent.md).

## Tech Stack

| Layer           | Technology                                                            |
| --------------- | --------------------------------------------------------------------- |
| Runtime         | [Cloudflare Workers](https://workers.cloudflare.com/)                 |
| UI Framework    | [Remix 3](https://remix.run/) (alpha)                                 |
| Package Manager | [npm](https://www.npmjs.com/)                                         |
| Workspace       | [Nx](https://nx.dev/) + npm workspaces                                |
| Database        | [Cloudflare D1](https://developers.cloudflare.com/d1/)                |
| Session/OAuth   | [Cloudflare KV](https://developers.cloudflare.com/kv/)                |
| MCP State       | [Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| E2E Testing     | [Playwright](https://playwright.dev/)                                 |
| Bundler         | [esbuild](https://esbuild.github.io/)                                 |

## Scope

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
              ├─→ Static assets (`packages/worker/public/`)
              └─→ Server router → Remix components
```

- `packages/worker/src/index.ts` is the entrypoint for Cloudflare Workers
- OAuth requests are handled first, then MCP requests, then static assets
- Non-asset requests fall through to the server handler and router
- Client assets are bundled into `packages/worker/public/` and served via the
  `ASSETS` binding

## Documentation

| Document                                                                                     | Description                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------ |
| [`docs/contributing/getting-started.md`](./docs/contributing/getting-started.md)             | Setup, environment variables, deploy |
| [`docs/contributing/environment-variables.md`](./docs/contributing/environment-variables.md) | Adding new env vars                  |
| [`docs/contributing/cloudflare-offerings.md`](./docs/contributing/cloudflare-offerings.md)   | Optional Cloudflare integrations     |
| [`docs/contributing/project-intent.md`](./docs/contributing/project-intent.md)               | Scope, goals, and non-goals          |
| [`docs/contributing/index.md`](./docs/contributing/index.md)                                 | Developing and extending Kody        |
| [`docs/use/index.md`](./docs/use/index.md)                                                   | Using Kody over MCP                  |
| [`docs/contributing/setup.md`](./docs/contributing/setup.md)                                 | Local development and verification   |

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://epicweb.dev">Epic Web</a></sub>
</div>
