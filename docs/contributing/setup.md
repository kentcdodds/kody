# Setup

Quick notes for getting a local kody environment running.

## Prerequisites

- Node 26 and npm (used for installs and scripts).

## Install

- `npm install`
- The repo root hosts the Nx workspace metadata; runtime packages live under
  `packages/`.

## Local development

- **Cloudflare D1 and KV**: Local development does **not** require creating or
  linking remote D1 databases or KV namespaces. `npm run dev` runs the worker
  with local Wrangler persistence for D1/KV emulation.
- **Production and preview deploys**: GitHub Actions do not rely on IDs baked
  into the repo. They run `node tools/ci/production-resources.ts ensure`
  (production) or `node tools/ci/preview-resources.ts ensure` (per-preview
  worker name), which create or resolve the D1 database and OAuth KV namespace,
  then write generated Wrangler configs with real `database_id` and KV `id`
  values: `packages/worker/wrangler-production.generated.json` and
  `packages/worker/wrangler-preview.generated.json` (gitignored). KV titles
  follow the worker name: production defaults to `<worker-name>-oauth`; preview
  uses `<preview-worker-name>-oauth-kv` (see `tools/ci/preview-resources.ts`).
- **Exporting from an existing remote D1**: export the remote database to a
  local SQLite file with `tools/export-d1-remote-to-sqlite.sh`, then copy only
  the tables you need into the local Kody database.
- Copy `packages/worker/.env.example` to `packages/worker/.env` before starting
  any work, then update secrets as needed. The example includes placeholder
  values for `COOKIE_SECRET` and `SECRET_STORE_KEY`; all environments must set
  both secrets (see
  [`docs/contributing/secret-rotation.md`](./secret-rotation.md)).
- `npm run dev` starts mock API servers automatically plus the main worker; it
  sets `CLOUDFLARE_API_BASE_URL`, `CLOUDFLARE_API_TOKEN`, and
  `CLOUDFLARE_ACCOUNT_ID` to the local Cloudflare API mock Worker for the
  internal Cloudflare API client, local email sending, and Artifacts REST repo
  create/get/list/token/fork calls. Those REST calls do not hit the live
  Cloudflare Artifacts control plane during normal local development. The mock
  covers only the REST control plane; repo-session git clone/pull/push flows
  need a real Git-capable Artifacts remote and are not fully simulated by the
  local mock. Password reset and email-verification messages send through the
  same Cloudflare Email API helper; password reset uses
  `kody@<APP_BASE_URL hostname>` when `APP_BASE_URL` is set, and verification
  can fall back to the request origin for local/E2E signup flows. Set
  `SKIP_CLOUDFLARE_MOCK=1` to skip the local Cloudflare mock entirely. The main
  worker streams logs live; the client bundle and background mock workers buffer
  logs and only print them if that child process exits with an error.
- MCP **`search`** uses a deterministic offline ranker in tests and when
  `WRANGLER_IS_LOCAL_DEV` is set (no Vectorize / Workers AI embedding calls
  required for `npm run test` or unauthenticated local runs). Production uses
  Vectorize plus the Workers AI `@cf/baai/bge-small-en-v1.5` embedding model
  through the `AI` binding, optionally routed through AI Gateway; see
  `docs/contributing/environment-variables.md`.
- Add new mock API servers by following `docs/contributing/mock-api-servers.md`.
- If you only need the client bundle or worker, use:
  - `npm run dev:client`
  - `npm run dev:worker`
- Set `CLOUDFLARE_ENV` to switch Wrangler environments (defaults to
  `production`). Playwright sets this to `test`.

## Checks

- `git commit` runs the Husky `pre-commit` hook, which formats staged
  JavaScript/TypeScript/JSON/Markdown/CSS files with `oxfmt`, applies
  `oxlint --fix` to staged JavaScript/TypeScript files, runs `npm run typecheck`
  for the repo, and runs `npm run migrations:check` before the commit is
  created.
- `git push` runs the Husky `pre-push` hook, which executes `npm run test:push`
  so pushes are blocked when the worker Vitest suites or Playwright E2E suite
  fail.
- Because the commit hook already enforces formatting, lint fixes, and
  typechecking, agents do not need to run those checks separately before every
  commit unless they want earlier feedback or are validating a larger change set
  before opening a PR.
- Push-time hooks intentionally stop short of `npm run validate`; MCP E2E and
  repo-wide format checks remain explicit checks because they are heavier than
  the push gate.
- `npm run validate` is the single authoritative gate and is what CI runs. It is
  read-only and executes `format:check`, `lint`, `typecheck`, unit tests,
  Playwright E2E, MCP E2E, `primitives:check`, and `migrations:check` in
  parallel, reporting every failure (sibling checks are not aborted on the first
  failure). If `npm run validate` passes locally, CI will pass.
- `npm run validate:fix` runs `format` + `lint:fix` and is the explicit opt-in
  for mutating auto-fixes. It is never required to pass `validate`.
- `npm run format` applies formatting updates on its own.
- `npm run test:push` runs the same worker tests and Playwright E2E suite
  enforced by the Husky `pre-push` hook.
- `npm run test:e2e:run` ensures Playwright Chromium is installed before the
  suite starts, so `npm run validate` and `npm run test:push` self-heal on a
  fresh machine.
- Use `npm run test:e2e:install` when you want to prefetch Playwright browsers
  ahead of time instead of waiting for the first E2E run.
- `npm run test:e2e:run` runs the Playwright suite through Nx and depends on a
  cached `worker:prepare-e2e-env` target for `.env` bootstrap plus an uncached
  `worker:prepare-playwright` target that checks the local Chromium install.
- `npm run test:mcp` runs MCP server E2E tests and also depends on the cached
  `worker:prepare-e2e-env` target, which writes `packages/worker/.env` from
  `.env.example` when needed and backfills `COOKIE_SECRET` before the test run.

## Authoring D1 migrations

- New migration files live in `packages/worker/migrations/` and are applied in
  lexicographic filename order by Wrangler (`npm run migrate:local`,
  `migrate:e2e`, and the documented `d1 migrations apply APP_DB --remote`
  invocations below).
- Name new files `NNNN-kebab-case-description.sql` (four-digit prefix, hyphen,
  kebab-case slug). Pick the next prefix as `(max numeric prefix) + 1`,
  zero-padded to four digits (for example, if the highest prefix is `0075`, use
  `0076-my-change.sql`).
- If your branch is behind `main` and a new migration has landed upstream with
  the prefix you picked, rebase and renumber your file to a new unused prefix.
  Do not introduce new duplicate prefixes.
- Do not edit migration files that have already landed in `main` and been
  deployed. New migration files that only exist on your branch can be revised
  freely until they land in `main`; once deployed, any schema correction should
  ship as a new migration instead.
- `npm run migrations:check` (also run by `npm run validate` and the pre-commit
  hook) enforces the naming rules above.
- Seven historical duplicate prefixes are permanently accepted only for their
  exact existing filename pairs — applied migrations cannot be renamed, and
  Wrangler orders lexicographically. Do not rename these files or add a third
  file to any of these prefixes:
  - `0009-ui-artifact-parameters.sql` / `0009-secret-allowed-hosts.sql`
  - `0010-value-buckets.sql` / `0010-secret-allowed-capabilities.sql`
  - `0018-mcp-memory-source-uris.sql` / `0018-jobs.sql`
  - `0023-secret-allowed-packages.sql` / `0023-entity-sources.sql`
  - `0037-package-runtime-debug.sql` / `0037-drop-chat-threads.sql`
  - `0053-two-factor-passkeys.sql` / `0053-mcp-server-settings.sql`
  - `0073-community-forks-forked-package-index.sql` /
    `0073-agent-package-conversation-uses.sql`

## Documentation maintenance

- Read `docs/contributing/project-intent.md` before making product-level changes
  or writing docs that describe the project's goals.
- Follow [Documentation principles](./documentation.md) for usage docs, MCP
  instruction text, and contributing guides (lightweight pages, current
  behavior, post-tool detail in responses).
- Update `docs/use/` when end-user MCP behavior or guidance changes; update
  `docs/contributing` when contributor workflows, architecture notes, or
  verification guidance change.
- Treat docs updates as part of done work.
- Keep `AGENTS.md` concise and index-like; put details in focused docs.
- When failures repeat, promote lessons from docs into tests, lint rules, or
  scripts.

## Seed test account

Use this script to ensure a known test login exists in any deployed environment:

- Local D1 (default):
  - `npm run migrate:local`
  - `node tools/seed-test-data.ts --local`
- Local D1 with custom persisted state:
  - `node tools/seed-test-data.ts --local --persist-to .wrangler/state/e2e`
- Remote D1:
  - `node tools/seed-test-data.ts --remote --config <wrangler-config-path>`
  - Add `--env <name>` when the config uses environment-scoped bindings and the
    environment is not already set via `CLOUDFLARE_ENV`.
- Default fixture credentials (both use password `ilikecode`):
  - `kody@example.com` — seeded with the `admin` role so RBAC features (the
    `/admin` pages) are testable out of the box
  - `jane@example.com` — regular account (`user` role only), seeded alongside
    the primary account for testing the non-admin side of RBAC (local seeding
    only; never seeded into remote environments)
- These credentials are a test fixture only and should not be used to describe
  product behavior. Pass `--no-admin` to seed the default account without the
  admin role.
- Choose explicit fixture credentials when needed (custom accounts are non-admin
  unless you pass `--admin`):
  - `node tools/seed-test-data.ts --email <email> --password <password>`
- When changing DB schema/model definitions or migrations, review
  `tools/seed-test-data.ts` and update it so seeded data matches the new model
  and stays useful for local and preview verification.

### Reset, re-migrate, then seed

For a full local reset before seeding:

1. Drop app tables:
   - `node ./wrangler-env.ts d1 execute APP_DB --local --command "PRAGMA foreign_keys=OFF; DROP TABLE IF EXISTS password_resets; DROP TABLE IF EXISTS users; PRAGMA foreign_keys=ON;"`
2. Re-apply migrations:
   - `npm run migrate:local`
3. Seed test account:
   - `node tools/seed-test-data.ts`

For preview environments, we do a full resource reset:

1. Delete preview resources:
   - `node tools/ci/preview-resources.ts cleanup --worker-name <preview-worker-name>`
2. Recreate preview resources and config:
   - `node tools/ci/preview-resources.ts ensure --worker-name <preview-worker-name> --out-config packages/worker/wrangler-preview.generated.json`
3. Re-apply remote migrations:
   - `CLOUDFLARE_ENV=preview node ./wrangler-env.ts d1 migrations apply APP_DB --remote --config packages/worker/wrangler-preview.generated.json`
4. Seed test account:
   - `CLOUDFLARE_ENV=preview node tools/seed-test-data.ts --remote --config packages/worker/wrangler-preview.generated.json`

## PR preview deployments

The GitHub Actions preview workflow creates per-preview Cloudflare resources so
each PR preview is isolated:

- D1 database: `<preview-worker-name>-db`
- KV namespace (OAuth state): `<preview-worker-name>-oauth-kv`

When a PR is closed, the cleanup job deletes the preview Worker(s), mock
Workers, and these resources as well.

Cloudflare Workers supports version `preview_urls`, but those preview URLs are
not available for Workers that use Durable Objects. The main app Worker binds
`MCP_OBJECT`, so app previews use per-PR Worker names. Mock Workers do not use
Durable Objects, so their Wrangler configs opt into `preview_urls = true` and
the workflow includes mock version preview links when Cloudflare returns them.

Production deploys also ensure required Cloudflare resources exist before
migrations/deploy:

- D1 database: from `env.production.d1_databases` binding `APP_DB`
- KV namespace: `OAUTH_KV` (defaults to `<worker-name>-oauth` when creating)

Both the preview and production deploy workflows run a post-deploy healthcheck
against `<deploy-url>/health` and fail the job if it does not return
`{ ok: true, commitSha }` with `commitSha` matching the commit SHA deployed by
that workflow.

Preview deploys also run `node tools/seed-test-data.ts` after deploy to create
or verify the shared test account credentials listed above.

Preview cleanup also deletes the matching GitHub environment
(`preview-<pr-number>`). That API requires repository administration write
access, so the repo must define a `PREVIEW_ENVIRONMENT_ADMIN_TOKEN` Actions
secret with a token that has that permission. Cleanup intentionally fails when
that secret is missing or under-scoped so permission regressions are visible.

The production deploy workflow can also be started manually from GitHub Actions
via **Run workflow** on `main`. The manual path verifies that the selected
commit is the current `origin/main` HEAD before it deploys.

If you ever need to do the same operations manually, use:

- `node tools/ci/preview-resources.ts ensure --worker-name <name> --out-config <path>`
- `node tools/ci/preview-resources.ts cleanup --worker-name <name>`
- `node tools/ci/production-resources.ts ensure --out-config <path>`

## Dependency auditing

- `npm run audit:prod` checks production dependencies for known vulnerabilities
  (runs `npm audit --omit=dev`). This should return zero high or moderate
  findings before merging to `main`.
- See [`docs/contributing/dependency-overrides.md`](./dependency-overrides.md)
  for any `overrides` entries in the root `package.json` and their
  justifications.

## Remix skills

Use [Remix skills](./remix.md) instead of vendoring generated package docs in
this repo.
