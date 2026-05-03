# Setup

Quick notes for getting a local kody environment running.

## Prerequisites

- Node 24 and npm (used for installs and scripts).

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
- **Migrating from a legacy D1**: export a remote database to a local SQLite
  file and copy only the tables you need — see
  [`docs/contributing/d1-legacy-export.md`](./d1-legacy-export.md) and
  `tools/export-d1-remote-to-sqlite.sh`.
- Copy `packages/worker/.env.example` to `packages/worker/.env` before starting
  any work, then update secrets as needed. The example includes placeholder
  values for `COOKIE_SECRET` and `SECRET_STORE_KEY`; all environments must set
  both secrets (see
  [`docs/contributing/secret-rotation.md`](./secret-rotation.md)).
- `npm run dev` (starts mock API servers automatically, the main worker, and the
  local home connector; it sets `AI_MODE=mock`, `AI_MOCK_BASE_URL`, and
  `CLOUDFLARE_API_BASE_URL` + `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
  to the local Cloudflare API mock Worker for the internal Cloudflare API
  client, local email sending, and Artifacts REST repo
  create/get/list/token/fork calls. Those REST calls do not hit the live
  Cloudflare Artifacts control plane during normal local development. The mock
  covers only the REST control plane; repo-session git clone/pull/push flows
  need a real Git-capable Artifacts remote and are not fully simulated by the
  local mock. Password reset email sends as `kody@<APP_BASE_URL hostname>` and
  requires `APP_BASE_URL` to be set. Set `SKIP_CLOUDFLARE_MOCK=1` to skip the
  local Cloudflare mock entirely. The home connector receives the resolved
  worker origin via `WORKER_BASE_URL`. When `HOME_CONNECTOR_SHARED_SECRET` is
  unset, the launcher generates one and passes it to both the worker and the
  connector so the outbound registration handshake succeeds in local
  development. The main worker and home connector stream logs live; the client
  bundle and background mock workers buffer logs and only print them if that
  child process exits with an error.)
- The home automation connector lives in `packages/home-connector`.
  - `npm run dev:home-connector` starts the local connector app on Node 24 with
    `node --watch`, so connector code changes automatically restart the local
    process.
  - The connector uses the `kentcdodds.com` mock bootstrap shape: only
    `packages/home-connector/index.ts` imports `packages/home-connector/mocks/`
    when `MOCKS=true`.
  - The dev entry at `packages/home-connector/server/dev-server.ts` enables
    `MOCKS=true` by default for local development and also sets
    `ROKU_DISCOVERY_URL=http://roku.mock.local/discovery`,
    `LUTRON_DISCOVERY_URL=http://lutron.mock.local/discovery`, and
    `SAMSUNG_TV_DISCOVERY_URL=http://samsung-tv.mock.local/discovery` unless you
    override them.
  - `npm run dev` forwards `HOME_CONNECTOR_*` environment variables to the
    underlying connector process with the prefix removed, so
    `HOME_CONNECTOR_MOCKS=false` becomes `MOCKS=false` and
    `HOME_CONNECTOR_ROKU_DISCOVERY_URL=...` becomes `ROKU_DISCOVERY_URL=...`.
    Likewise, `HOME_CONNECTOR_LUTRON_DISCOVERY_URL=...` becomes
    `LUTRON_DISCOVERY_URL=...`, `HOME_CONNECTOR_SAMSUNG_TV_DISCOVERY_URL=...`
    becomes `SAMSUNG_TV_DISCOVERY_URL=...`, `HOME_CONNECTOR_DATA_PATH=...`
    becomes `HOME_CONNECTOR_DATA_PATH=...`, and `HOME_CONNECTOR_DB_PATH=...`
    becomes `HOME_CONNECTOR_DB_PATH=...` in the connector process.
  - When `ROKU_DISCOVERY_URL` is unset, the connector defaults Roku discovery to
    SSDP at `ssdp://239.255.255.250:1900`.
  - When `LUTRON_DISCOVERY_URL` is unset, the connector defaults Lutron
    discovery to `mdns://_lutron._tcp.local`. Live discovery uses one
    cross-platform pure-JS mDNS path, so the same code works on macOS and in
    Linux containers as long as the process has multicast visibility to the LAN.
  - When `SAMSUNG_TV_DISCOVERY_URL` is unset, the connector defaults Samsung TV
    discovery to `mdns://_samsungmsf._tcp.local`. Live discovery uses the same
    cross-platform pure-JS mDNS path, so the same code works on macOS and in
    Linux containers as long as the process has multicast visibility to the LAN.
  - Samsung TV pairing tokens/device metadata and Lutron processor
    credentials/metadata are persisted locally in a SQLite database. By default
    the connector stores that DB at
    `~/.kody/home-connector/home-connector.sqlite`. Override the directory with
    `HOME_CONNECTOR_DATA_PATH` or the full file path with
    `HOME_CONNECTOR_DB_PATH`.
  - Island router SSH diagnostics are optional. Set `ISLAND_ROUTER_HOST`,
    `ISLAND_ROUTER_USERNAME`, and `ISLAND_ROUTER_PRIVATE_KEY_PATH` to enable the
    typed MCP tools for router status, host diagnosis, WAN/failover state,
    routing/NAT/session inspection, VLAN/DNS/DHCP policy inspection, VPN/NTP/
    syslog/SNMP/system-health reads, and the other typed read-only router
    diagnostics exposed by the home connector. The current read surface is
    intentionally aligned to CLI families verified against live Island Pro
    firmware: config-style reads primarily source from `show running-config`,
    connection/state reads use commands such as `show ip neighbors`,
    `show ip routes`, `show ip sockets`, and `show vpns`, while NTP uses
    `show ntp status` plus `show ntp associations`, and system-health summaries
    use `show stats` plus `show hardware`.
  - Prefer mounting the private key read-only into the container or host
    runtime, for example
    `-v /path/to/id_ed25519:/run/secrets/island-router-key:ro` plus
    `HOME_CONNECTOR_ISLAND_ROUTER_PRIVATE_KEY_PATH=/run/secrets/island-router-key`
    when launching through `npm run dev`, or
    `ISLAND_ROUTER_PRIVATE_KEY_PATH=/run/secrets/island-router-key` when running
    `packages/home-connector` directly.
  - For host verification, set either `ISLAND_ROUTER_KNOWN_HOSTS_PATH`
    (preferred) or `ISLAND_ROUTER_HOST_FINGERPRINT`. When neither is set, the
    connector still works but reports a warning because SSH host verification is
    disabled.
  - The Island router integration intentionally does not expose arbitrary
    command execution over MCP. It uses a typed allowlist of documented CLI
    commands.
  - High-risk Island router write tools are available when SSH host verification
    is configured with `ISLAND_ROUTER_KNOWN_HOSTS_PATH` or
    `ISLAND_ROUTER_HOST_FINGERPRINT`. The allowlisted mutating tools include
    targeted operational actions such as WAN failover forcing, DHCP reservation
    changes, reboot, interface-description changes, DNS-server changes,
    block/unblock-host actions, DHCP client renewal, log clearing, config save,
    and a narrowly allowlisted router CLI escape hatch.
  - These write tools exist for carefully scoped operational recovery only.
    Their tool descriptions intentionally use strong language because mistakes
    can disrupt connectivity, erase diagnostics, or persist a bad router state
    with severe consequences. Agents must be highly certain before using them.
  - Local operational routes live at `/health`, `/roku/status`, `/roku/setup`,
    `/lutron/status`, `/lutron/setup`, `/samsung-tv/status`, and
    `/samsung-tv/setup`.
  - The Lutron tool surface intentionally focuses on dynamic processor
    discovery, persisted credentials, LEAP inventory reads over `8081`, keypad
    button presses, and direct zone level changes. It does not use the more
    privileged `8902` QSX channel.
  - The Samsung TV tool surface intentionally focuses on discovery, pairing,
    remote keys, known-app probing, explicit app launch by app ID, and Art Mode
    control.
  - Samsung power support is exposed as best-effort `power off` and `power on`
    actions. Power off uses the local Samsung remote channel and power on uses
    Wake-on-LAN with the stored TV MAC address. These semantics are model- and
    firmware-dependent, especially on Frame TVs where the regular power key may
    be mapped to Art Mode rather than true standby.
  - Full installed-app enumeration is considered model- and firmware-dependent.
- MCP **`search`** uses a deterministic offline ranker in tests and when
  `WRANGLER_IS_LOCAL_DEV` is set (no Vectorize / Workers AI embedding calls
  required for `npm run test` or unauthenticated local runs). Production uses
  Vectorize plus Workers AI; see `docs/contributing/environment-variables.md`.
- Add new mock API servers by following `docs/contributing/mock-api-servers.md`.
- To opt into live remote inference locally, set `AI_MODE=remote` before
  starting `npm run dev`.
- When `AI_MODE=remote`, set `AI_GATEWAY_ID`, `CLOUDFLARE_ACCOUNT_ID`, and
  `CLOUDFLARE_API_TOKEN` in `packages/worker/.env`; remote AI mode requires
  requests to flow through a configured Cloudflare AI Gateway using your
  Cloudflare account credentials. If any are missing, `npm run dev` fails fast
  with an explanatory startup error.
- Local remote inference does not require `wrangler dev --remote`; the normal
  dev server keeps local Durable Objects/D1 while routing Workers AI calls
  through Cloudflare using the configured account credentials.
- If you only need the client bundle or worker, use:
  - `npm run dev:client`
  - `npm run dev:worker`
- Set `CLOUDFLARE_ENV` to switch Wrangler environments (defaults to
  `production`). Playwright sets this to `test`.

## Checks

- `git commit` runs the Husky `pre-commit` hook, which formats staged
  JavaScript/TypeScript/JSON/Markdown/CSS files with `oxfmt`, applies
  `oxlint --fix` to staged JavaScript/TypeScript files, and then runs
  `npm run typecheck` for the repo before the commit is created.
- `git push` runs the Husky `pre-push` hook, which executes `npm run test:push`
  so pushes are blocked when the worker Vitest suites or Playwright E2E suite
  fail.
- Because the commit hook already enforces formatting, lint fixes, and
  typechecking, agents do not need to run those checks separately before every
  commit unless they want earlier feedback or are validating a larger change set
  before opening a PR.
- Push-time hooks intentionally stop short of `npm run validate`; MCP E2E, build
  validation, and repo-wide format checks remain explicit checks because they
  are heavier than the push gate.
- `npm run validate` runs format check, lint fix, build, typecheck, Playwright
  tests, and MCP E2E tests.
- `npm run format` applies formatting updates.
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

## Home Connector Docker publishing

Pushes to `main` that change `packages/home-connector/**`, `package.json`,
`package-lock.json`, or `.github/workflows/home-connector-publish.yml` run the
dedicated Home Connector publish workflow.

- The workflow reruns `npm --prefix packages/home-connector run test` before
  publishing.
- Docker Hub auth comes from GitHub Actions secrets `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN`.
- The Docker Hub repository name comes from the GitHub Actions variable
  `HOME_CONNECTOR_DOCKER_IMAGE` (for example `kentcdodds/kody-home-connector`).
- Successful publishes push both `latest` and `sha-<shortsha>` tags.

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
- Do not edit migration files that have already landed in `main` and been
  deployed. New migration files that only exist on your branch can be revised
  freely until they land in `main`; once deployed, any schema correction should
  ship as a new migration instead.

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
- Default credentials:
  - email: `me@kentcdodds.com`
  - password: `iliketwix`
- Override credentials when needed:
  - `node tools/seed-test-data.ts --email <email> --password <password>`
- When changing DB schema/model definitions or migrations, review
  `tools/seed-test-data.ts` and update it so seeded data matches the new model
  and remains useful for local and preview verification.

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

When a PR is closed, the cleanup job deletes the preview Worker(s) and these
resources as well.

Cloudflare Workers supports version `preview_urls`, but those preview URLs are
not available for Workers that use Durable Objects. The main app Worker binds
`MCP_OBJECT`, so app previews continue to use per-PR Worker names. Mock Workers
do not use Durable Objects, so their Wrangler configs opt into
`preview_urls = true` and the workflow includes mock version preview links when
Cloudflare returns them.

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
