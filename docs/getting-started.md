# kody Setup

<!--
If you're an agent reading this, do as much as you can yourself and then
tell the user what else they need to do themselves.
-->

Use these steps to run `kody` locally and on Cloudflare Workers.

If you are here to understand the purpose of this repository rather than set it
up, read [`docs/project-intent.md`](./project-intent.md) first. This repo still
has some template lineage in its docs and structure, but the current project
intent is to build a personal assistant with an MCP-first architecture.

## Create the project with degit

```
bunx degit epicweb-dev/epicflare my-kody-app
cd my-kody-app
```

## Install dependencies

We use bun for scripts and installs.

```
bun install
```

## Expectations and assumptions

The setup flow assumes:

- Bun is installed (uses `bun`/`bunx`).
- You run commands from the repo root (needs `wrangler.jsonc` and
  `package.json`).
- You can write to files in the repository (the script updates config files and
  replaces template `kody` tokens across text files).
- Wrangler is optional for post-download setup. It is only needed when you
  choose to create Cloudflare resources directly from the script.

See `docs/setup-manifest.md` for required resources and secrets.

For optional Cloudflare offerings (R2, Workers AI, AI Gateway, extra KV), see
`docs/cloudflare-offerings.md`.

## Preflight checks

Run a quick validation of your environment and Wrangler login status:

```
bun ./docs/post-download.ts --check
```

## Quick Start (local only)

1. Run the guided setup script:

```
bun ./docs/post-download.ts --guided
```

2. Start local development:

```
bun run dev
```

## Full Cloudflare setup (deploy)

1. Run the guided setup script:

```
bun ./docs/post-download.ts --guided
```

This setup step does not create Cloudflare resources or rewrite `wrangler.jsonc`
resource IDs. The production deploy workflow creates missing D1/KV resources
automatically on first CI deploy. Cloudflare deploys do not auto-create those
resources from bindings alone, so the workflow runs an explicit ensure step
before migrations/deploy.

2. Configure GitHub Actions secrets and variables for deploy:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account)
- `COOKIE_SECRET` (generate with `openssl rand -hex 32` or similar)
- See `docs/setup-manifest.md` (`GitHub Actions configuration`) for full
  optional secrets/variables and where to get each value.

3. Deploy:

```
bun run deploy
```

## Agent/CI setup

Use non-interactive flags or `--defaults`. The `--defaults` flag skips prompts
and uses defaults based on the current directory name (app/package naming), plus
a generated cookie secret.

```
bun ./docs/post-download.ts --defaults
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
Cloudflare resources or rewrite `wrangler.jsonc` resource IDs.

## Local development

See `docs/agents/setup.md` for local dev commands and verification steps.

To create a deterministic test login in a running environment:

```bash
bun run migrate:local
bun tools/seed-test-data.ts --local
```

Default test credentials:

- Email: `me@kentcdodds.com`
- Password: `iliketwix`

## Build and deploy

Build the project:

```
bun run build
```

Deploy to Cloudflare:

```
bun run deploy
```
