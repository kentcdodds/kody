# kody Setup

<!--
If you're an agent reading this, do as much as you can yourself and then
tell the user what else they need to do themselves.
-->

Use these steps to run `kody` locally and on Cloudflare Workers.

If you are here to understand the purpose of this repository rather than set it
up, read [`docs/contributing/project-intent.md`](./project-intent.md) first.
Some docs and parts of the repo structure reflect starter-oriented conventions,
and the project intent is to build a personal assistant with an MCP-first
architecture.

## Install dependencies

We use npm for installs and scripts, with Node 26 as the runtime.

```bash
npm install
```

To scaffold a **new** project from the epicflare template instead of working
inside this repo, run `npx create-epicflare`.

## Expectations and assumptions

The setup flow assumes:

- Node 26 and npm are installed.
- You run commands from the repo root (needs `nx.json`, `package.json`, and
  `packages/worker/wrangler.jsonc`).
- **Cloudflare D1 and KV**: The checked-in
  [`packages/worker/wrangler.jsonc`](../../packages/worker/wrangler.jsonc)
  declares bindings and `database_name` values but does **not** commit remote
  resource IDs (`database_id`, KV `id` / `preview_id`). Production and preview
  deploys run ensure scripts that create or resolve resources and write
  generated Wrangler configs with real IDs (see `docs/contributing/setup.md`).
  **Local development does not require** provisioning remote D1 or KV;
  `npm run dev` uses local Wrangler persistence.

See `docs/contributing/setup-manifest.md` for required resources and secrets.

For optional Cloudflare offerings (R2, Workers AI, AI Gateway, extra KV), see
`docs/contributing/cloudflare-offerings.md`.

## Preflight checks

Verify Node 26 and that dependencies are installed:

```bash
node --version   # expect v26.x
npm install
```

For deploy work, confirm Wrangler can reach your Cloudflare account:

```bash
npx wrangler whoami
```

## Quick Start (local only)

1. Copy the local environment file and adjust secrets if needed:

```bash
cp packages/worker/.env.example packages/worker/.env
```

`COOKIE_SECRET` and `SECRET_STORE_KEY` are required. The example file includes
placeholder values that work for local development.

2. Apply local D1 migrations:

```bash
npm run migrate:local
```

3. Start local development:

```bash
npm run dev
```

The CLI prints the resolved URL (default port `3742`). Health check:

```bash
curl http://localhost:<port>/health
```

## Full Cloudflare setup (deploy)

Local setup does not create Cloudflare resources. The checked-in Wrangler
template omits remote D1/KV IDs on purpose. The production deploy workflow runs
`node tools/ci/production-resources.ts ensure`, which creates missing D1/KV
resources when needed and writes
`packages/worker/wrangler-production.generated.json` with resolved IDs for that
deploy. Cloudflare deploys do not auto-create those resources from bindings
alone, so the workflow runs that ensure step before migrations/deploy.

1. Configure GitHub Actions secrets and variables for deploy:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit + Workers KV Storage:Edit
  access on the correct account)
- `COOKIE_SECRET` (generate with `openssl rand -hex 32` or similar)
- See `docs/contributing/setup-manifest.md` (`GitHub Actions configuration`) for
  full optional secrets/variables and where to get each value.

2. Deploy:

```bash
npm run deploy
```

## Agent/CI setup

For non-interactive or automated setup:

1. Ensure `packages/worker/.env` exists (copy from `.env.example` if missing).
2. Run migrations and the full validation gate:

```bash
npm run migrate:local
npm run validate
```

`npm run validate` is the single authoritative local gate. It runs format, lint,
typecheck, unit tests, Playwright E2E, MCP E2E, backup build, and structure
checks in parallel. CI runs the same checks as parallel jobs.

To seed a deterministic test login after migrations:

```bash
node tools/seed-test-data.ts --local
```

Cloudflare resources are managed during deploy. Deploy-time ensure steps inject
real D1/KV IDs into generated Wrangler configs (not into the checked-in
template).

## Local development

See `docs/contributing/setup.md` for local dev commands and verification steps.

To create a deterministic test login in a running environment:

```bash
npm run migrate:local
node tools/seed-test-data.ts --local
```

Default fixture credentials (both use password `ilikecode`):

- `kody@example.com` — admin fixture (seeded with the `admin` role)
- `jane@example.com` — regular fixture (`user` role only)

These credentials are a local test fixture only. Pass
`--email <email> --password <password>` when you need explicit fixture
credentials (custom accounts are non-admin unless you pass `--admin`).

## Build and deploy

Build the project:

```bash
npm run build
```

Deploy to Cloudflare:

```bash
npm run deploy
```
