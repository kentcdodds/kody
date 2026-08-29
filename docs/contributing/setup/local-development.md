# Local development

Prerequisites, install, and `npm run dev` notes. See the
[setup index](./index.md) for checks, migrations, seeding, and preview deploys.

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
  worker name), which create or resolve app/audit D1 databases and the OAuth KV
  namespace, then write generated Wrangler configs with real `database_id` and
  KV `id` values: `packages/worker/wrangler-production.generated.json` and
  `packages/worker/wrangler-preview.generated.json` (gitignored). Preview and
  production also ensure sibling platform/runtime/jobs worker configs and
  `JOBS_DB`. KV titles follow the worker name: production defaults to
  `<worker-name>-oauth`; preview uses `<preview-worker-name>-oauth-kv` (see
  `tools/ci/preview-resources.ts`).
- **Exporting from an existing remote D1**: export the remote database to a
  local SQLite file with `tools/export-d1-remote-to-sqlite.sh`, then copy only
  the tables you need into the local Kody database.
- Copy `packages/worker/.env.example` to `packages/worker/.env` before starting
  any work, then update secrets as needed. The example includes placeholder
  values for `COOKIE_SECRET` and `SECRET_STORE_KEY`; all environments must set
  both secrets (see
  [`docs/contributing/secret-rotation.md`](../secret-rotation.md)).
- `npm run dev:ensure` reuses a healthy origin `/health` on 3742–3751 (prints
  `App running at http://localhost:<port>` and exits 0), replaces a stale
  kody/workerd leftover that is listening but not serving, then starts
  `npm run dev` and waits until `/health` is ok. Agents should call this instead
  of reconstructing a startup playbook from terminal files.
- `npm run dev` starts mock API servers automatically plus origin, platform,
  runtime, and jobs in one Miniflare; it sets `CLOUDFLARE_API_BASE_URL`,
  `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` to the local Cloudflare
  API mock Worker for the internal Cloudflare API client, local email sending,
  and Artifacts REST repo create/get/list/token/fork calls. Those REST calls do
  not hit the live Cloudflare Artifacts control plane during normal local
  development. The mock covers only the REST control plane; repo-session git
  clone/pull/push flows need a real Git-capable Artifacts remote and are not
  fully simulated by the local mock. Password reset and email-verification
  messages send through the same Cloudflare Email API helper. Both send from
  `kody@<SYSTEM_EMAIL_DOMAIN>` (falling back to the `APP_BASE_URL` hostname) and
  put that same sending domain on action and asset links, so a legacy
  `APP_BASE_URL` cannot pin `heykody.dev` into the message. Local `npm run dev`
  keeps those action and asset links on the request origin so they stay
  clickable. Set `SKIP_CLOUDFLARE_MOCK=1` to skip the local Cloudflare mock
  entirely. The main worker streams logs live; the client bundle and background
  mock workers buffer logs and only print them if that child process exits with
  an error.
- MCP **`search`** uses a deterministic offline ranker in tests and when
  `WRANGLER_IS_LOCAL_DEV` is set (no Vectorize / Workers AI embedding calls
  required for `npm run test` or unauthenticated local runs). Production uses
  Vectorize plus the Workers AI `@cf/baai/bge-small-en-v1.5` embedding model
  through the `AI` binding, optionally routed through AI Gateway; see
  [`environment-variables.md`](../environment-variables.md).
- Add new mock API servers by following
  [`mock-api-servers.md`](../mock-api-servers.md).
- If you only need the client bundle or worker, use:
  - `npm run dev:client`
  - `npm run dev:worker`
- Set `CLOUDFLARE_ENV` to switch Wrangler environments (defaults to
  `production`). Playwright sets this to `test`.
