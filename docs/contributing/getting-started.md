# kody Setup

<!--
If you're an agent reading this, do as much as you can yourself and then
tell the user what else they need to do themselves.
-->

Use these steps to run `kody` locally and on Cloudflare Workers.

If you are here to understand the purpose of this repository rather than set it
up, read [`docs/contributing/project-intent.md`](./project-intent.md) first.
This repo still has some template lineage in its docs and structure, but the
current project intent is to build a personal assistant with an MCP-first
architecture.

## Create the project with degit

```
npx degit epicweb-dev/epicflare my-kody-app
cd my-kody-app
```

## Install dependencies

We use npm for installs and scripts, with Node 24 as the runtime.

```
npm install
```

## Expectations and assumptions

The setup flow assumes:

- Node 24 and npm are installed.
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
- You can write to files in the repository (the script updates config files and
  replaces template `kody` tokens across text files).
- Wrangler is optional for post-download setup. It is only needed when you
  choose to create Cloudflare resources directly from the script.

See `docs/contributing/setup-manifest.md` for required resources and secrets.

For optional Cloudflare offerings (R2, Workers AI, AI Gateway, extra KV), see
`docs/contributing/cloudflare-offerings.md`.

## Preflight checks

Run a quick validation of your environment and Wrangler login status:

```
node ./docs/post-download.ts --check
```

## Quick Start (local only)

1. Run the guided setup script:

```
node ./docs/post-download.ts --guided
```

2. Start local development:

```
npm run dev
```

## Full Cloudflare setup (deploy)

1. Run the guided setup script:

```
node ./docs/post-download.ts --guided
```

This setup step does not create Cloudflare resources. The checked-in Wrangler
template omits remote D1/KV IDs on purpose. The production deploy workflow runs
`node tools/ci/production-resources.ts ensure`, which creates missing D1/KV
resources when needed and writes
`packages/worker/wrangler-production.generated.json` with resolved IDs for that
deploy. Cloudflare deploys do not auto-create those resources from bindings
alone, so the workflow runs that ensure step before migrations/deploy.

2. Configure GitHub Actions secrets and variables for deploy:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account)
- `COOKIE_SECRET` (generate with `openssl rand -hex 32` or similar)
- See `docs/contributing/setup-manifest.md` (`GitHub Actions configuration`) for
  full optional secrets/variables and where to get each value.

3. Deploy:

```
npm run deploy
```

## Agent/CI setup

Use non-interactive flags or `--defaults`. The `--defaults` flag skips prompts
and uses defaults based on the current directory name (app/package naming), plus
a generated cookie secret.

```
node ./docs/post-download.ts --defaults
```

To preview changes without writing, add `--dry-run`. To emit a JSON summary, add
`--json`. To run preflight checks only, add `--check`.

When running in a non-TTY shell, the script fails fast if required prompt values
are missing (for example `--app-name` without `--defaults`, and init choice when
`--guided` is set without `--init` or `--no-init`).

### Script flags

- `--guided`: interactive, state-aware flow (optional git init/first commit
  prompt).
- `--init` / `--no-init`: force or skip git init + initial `init` commit.
- `--check`: run preflight checks only.
- `--defaults`: accept defaults without prompts.
- `--dry-run`: show changes without writing or deleting the script.
- `--json`: print a JSON summary.
- `--app-name`: app name used for branding token replacement.
- `--package-name`: override package name (defaults to kebab-cased app name).
- `--github-username`: derives repository URL as
  `git+ssh://git@github.com/<username>/<package-name>.git`.
- `--repository-url`: explicit repository URL override.
- `--cookie-secret`: explicit `COOKIE_SECRET` value (otherwise generated).

Cloudflare resources are managed during deploy. The setup script does not create
Cloudflare resources; deploy-time ensure steps inject real D1/KV IDs into
generated Wrangler configs (not into the checked-in template).

## Local development

See `docs/contributing/setup.md` for local dev commands and verification steps.

To create a deterministic test login in a running environment:

```bash
npm run migrate:local
node tools/seed-test-data.ts --local
```

Default test credentials:

- Email: `me@kentcdodds.com`
- Password: `iliketwix`

## Build and deploy

Build the project:

```
npm run build
```

Deploy to Cloudflare:

```
npm run deploy
```
