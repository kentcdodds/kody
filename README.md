<div align="center">
  <img src="./public/logo.png" alt="kody logo" width="400" />

  <p>
    <strong>A starter and reference for building full-stack web applications on Cloudflare Workers</strong>
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

kody ships a Remix-powered UI, server routing, and OAuth-protected MCP
endpoints so you can build both a user-facing app and tooling APIs on the same
Worker.

## Quick Start

```bash
bunx create-epicflare
```

This will clone the template, install dependencies, run the guided setup, and
start the dev server.

See [`docs/getting-started.md`](./docs/getting-started.md) for the full setup
paths and expectations.

## Tech Stack

| Layer           | Technology                                                            |
| --------------- | --------------------------------------------------------------------- |
| Runtime         | [Cloudflare Workers](https://workers.cloudflare.com/)                 |
| UI Framework    | [Remix 3](https://remix.run/) (alpha)                                 |
| Package Manager | [Bun](https://bun.sh/)                                                |
| Database        | [Cloudflare D1](https://developers.cloudflare.com/d1/)                |
| Session/OAuth   | [Cloudflare KV](https://developers.cloudflare.com/kv/)                |
| MCP State       | [Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| E2E Testing     | [Playwright](https://playwright.dev/)                                 |
| Bundler         | [esbuild](https://esbuild.github.io/)                                 |

## How It Works

```
Request → worker/index.ts
              │
              ├─→ OAuth handlers
              ├─→ MCP endpoints
              ├─→ Static assets (public/)
              └─→ Server router → Remix components
```

- `worker/index.ts` is the entrypoint for Cloudflare Workers
- OAuth requests are handled first, then MCP requests, then static assets
- Non-asset requests fall through to the server handler and router
- Client assets are bundled into `public/` and served via the `ASSETS` binding

## Documentation

| Document                                                           | Description                          |
| ------------------------------------------------------------------ | ------------------------------------ |
| [`docs/getting-started.md`](./docs/getting-started.md)             | Setup, environment variables, deploy |
| [`docs/environment-variables.md`](./docs/environment-variables.md) | Adding new env vars                  |
| [`docs/cloudflare-offerings.md`](./docs/cloudflare-offerings.md)   | Optional Cloudflare integrations     |
| [`docs/agents/setup.md`](./docs/agents/setup.md)                   | Local development and verification   |

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://epicweb.dev">Epic Web</a></sub>
</div>
