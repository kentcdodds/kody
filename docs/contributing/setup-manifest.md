# Setup manifest

This document describes the infrastructure and secrets that kody expects.

## Cloudflare resources

This project uses the following resources:

- D1 database
  - `database_name`: `<app-name>`
- KV namespace for OAuth/session storage
  - `binding`: `OAUTH_KV`
  - `title`: `<app-name>-oauth`
- Cloudflare Email Sending / Email Service Worker binding
  - `binding`: `EMAIL`
  - `wrangler` key: `send_email`
  - Production domains still need Cloudflare-side sender/domain verification
    before sends succeed.
- Cloudflare Email Routing for inbound mail
  - Configure MX records and selected route aliases in the Cloudflare dashboard.
  - Route only test/storage aliases to the Worker until quarantine behavior is
    verified.
- Vectorize indexes for MCP capability search (`CAPABILITY_VECTOR_INDEX`)
  - Production: `kody-capabilities-prod`
  - Preview: `kody-capabilities-preview`
  - Create once per account, for example:
    `wrangler vectorize create kody-capabilities-prod --dimensions=384 --metric=cosine`
    (same for preview). **Dimensions must match** the embedding model in
    `packages/worker/src/mcp/capabilities/capability-search.ts`
    (`@cf/baai/bge-small-en-v1.5`).

The checked-in
[`packages/worker/wrangler.jsonc`](../../packages/worker/wrangler.jsonc)
declares bindings and names but **does not** commit remote D1 `database_id` or
KV `id` / `preview_id`, so forks do not accidentally bind to another project’s
resources.

Production CI deploys ensure these resources exist (create when missing) and
write resolved IDs into `packages/worker/wrangler-production.generated.json`
before migrations and deploy. Preview deploys do the same per preview worker via
`packages/worker/wrangler-preview.generated.json` (see
`docs/contributing/setup.md`). Cloudflare deploys do not auto-create these
resources from bindings alone, so the deploy workflow runs
`node tools/ci/production-resources.ts ensure` first.

## Optional Cloudflare offerings

The starter intentionally keeps the default footprint small. If you want to add
additional Cloudflare offerings (R2, Workers AI, AI Gateway, or a separate KV
namespace for app data), see:

- `docs/contributing/cloudflare-offerings.md`

## Rate limiting (Cloudflare dashboard)

Use Cloudflare's built-in rate limiting rules instead of custom Worker logic.

1. Open the Cloudflare dashboard for the zone that routes to your Worker.
2. Go to `Security` → `WAF` → `Rate limiting rules` (or `Rules` →
   `Rate limiting rules`).
3. Create a rule that targets auth endpoints, for example:
   - Expression:
     `(http.request.method eq "POST" and http.request.uri.path in {"/auth" "/oauth/authorize" "/oauth/token" "/oauth/register"})`
   - Threshold: `10` requests per `1 minute` per IP (tune as needed).
   - Action: `Block` or `Managed Challenge`.

## Environment variables

Local development uses `packages/worker/.env`, which Wrangler loads
automatically:

- `COOKIE_SECRET` (generate with `openssl rand -hex 32`)
- `APP_BASE_URL` (optional; defaults to request origin, example
  `https://app.example.com`; also sets the canonical public origin used for MCP
  auth metadata, generated UI resources, email links, and automated app-owned
  sender addresses like `kody@<app-domain>`)
- `APP_COMMIT_SHA` (optional; set automatically by deploy workflows for
  version-aware `/health` checks)
- `AI_GATEWAY_ID` (required when `AI_MODE=remote`; deploy workflows sync a
  gateway ID from GitHub Actions secrets so remote inference goes through
  Cloudflare AI Gateway)
- `CLOUDFLARE_ACCOUNT_ID` (required for local development when `AI_MODE=remote`
  so Wrangler can authenticate Workers AI requests against the correct account;
  also required for the Cloudflare Email Service REST API fallback used by local
  mocks and preview deploys)
- `CLOUDFLARE_API_TOKEN` (required for local development when `AI_MODE=remote`
  so Wrangler can authenticate Workers AI requests; also reused by the
  Cloudflare Email Service REST API fallback when local/preview email is routed
  through the Cloudflare mock or API)
- `SENTRY_DSN` (optional Cloudflare Worker secret; enables error reporting and
  tracing for the Worker and Durable Objects)
- `SENTRY_ENVIRONMENT` (set per deploy via `packages/worker/wrangler.jsonc`
  `vars` as `production`, `preview`, or `test`; optional override via env for
  local dev)
- `SENTRY_TRACES_SAMPLE_RATE` (optional `0`–`1`, defaults to **`1.0`** in code
  when unset — full sampling for low traffic; lower if volume grows)
- `APP_COMMIT_SHA` (used as the Sentry **release** when present, in addition to
  `/health` versioning)
- `CLOUDFLARE_API_BASE_URL` (optional; defaults to `https://api.cloudflare.com`.
  Production email uses the default public API base when this is unset. Local
  `npm run dev` targets the Cloudflare mock unless `SKIP_CLOUDFLARE_MOCK=1`. The
  internal Cloudflare API client expects paths under `/client/v4/`.)
- `CAPABILITY_REINDEX_SECRET` (optional Worker secret; bearer auth for
  `POST /__maintenance/reindex-capabilities` to refresh builtin capability
  embeddings in Vectorize. Saved package projections refresh when packages are
  saved or published.)

Tests run with `CLOUDFLARE_ENV=test` (set by Playwright) and read local secrets
from `packages/worker/.env`.

## GitHub Actions configuration

Configure these GitHub Actions secrets and variables for workflows:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account; also reused for remote AI and Cloudflare API workflows that run with
  account secrets + package workflows)
- `COOKIE_SECRET` (same format as local)
- `APP_BASE_URL` (optional GitHub Actions **variable**, used by the production
  deploy as the canonical public app origin and written into the generated
  Worker `vars` config before deploy)
- `AI_GATEWAY_ID` (required for production deploys that use remote AI inference)
- `AI_GATEWAY_ID_PREVIEW` (required for preview deploys that use remote AI
  inference)
- `SENTRY_DSN` (optional; create a JavaScript/Cloudflare project in Sentry and
  paste the DSN; syncs to the Worker as a secret when set in GitHub Actions)
- `CAPABILITY_REINDEX_SECRET` (optional; triggers post-deploy Vectorize reindex
  when set; synced like other optional secrets)
- `SENTRY_AUTH_TOKEN` (optional GitHub **secret**; Sentry auth token with
  `project:releases` / source map upload permissions — used only by CI to run
  `npm run sentry:upload-sourcemaps` after deploy)
- `DOCKERHUB_USERNAME` (required to publish `packages/home-connector` to Docker
  Hub)
- `DOCKERHUB_TOKEN` (required Docker Hub access token/password for image
  publish)
- `HOME_CONNECTOR_DOCKER_IMAGE` (required GitHub **variable**; Docker Hub image
  name such as `kentcdodds/kody-home-connector`)
- **Repository variables** `SENTRY_ORG` and `SENTRY_PROJECT` (optional; Sentry
  organization and project **slugs** for source map upload — same values as in
  the Sentry wizard’s `--org` / `--project` flags)

How to get/set each value:

- `CLOUDFLARE_API_TOKEN`
  - In Cloudflare Dashboard, create an API Token with permissions to deploy
    Workers and edit D1 on the target account. This is the same token to reuse
    for remote AI and Cloudflare API workflows that run with account secrets +
    skills; when you do, also include the product permissions needed for those
    APIs.
  - In GitHub: `Settings` → `Secrets and variables` → `Actions` →
    `New repository secret`.
- `COOKIE_SECRET`
  - Generate locally: `openssl rand -hex 32`
  - Store the exact value as a repository secret in GitHub Actions.
- `APP_BASE_URL` (optional)
  - Use your production app URL (for example `https://app.example.com`).
  - Add only if you want deploy-time health/version checks to use a fixed URL.
  - Production CI writes this into the generated Wrangler `vars` config before
    deploy, rather than syncing it as a Worker secret.
  - Do not also upload `APP_BASE_URL` through `wrangler secret bulk` or pass it
    as a deploy-time `--var`, because Wrangler treats that as a conflicting
    binding name.
- `AI_GATEWAY_ID`
  - Create a Cloudflare AI Gateway in the dashboard and copy its production
    gateway ID.
  - Store that value as the production GitHub Actions secret.
- `AI_GATEWAY_ID_PREVIEW`
  - Create a separate Cloudflare AI Gateway for previews and copy its gateway
    ID.
  - Store that value as the preview GitHub Actions secret so preview deploys
    sync a different worker secret than production.
- `SENTRY_DSN` (optional)
  - In Sentry: create a project, copy the DSN, and add it as the repository
    secret `SENTRY_DSN`. Production and preview deploy workflows sync it with
    `sync-worker-secrets.ts` when the secret is present.
- `SENTRY_AUTH_TOKEN` (optional)
  - In Sentry: **Settings → Auth Tokens** (or Organization settings), create a
    token that can upload releases/source maps, and store it as the
    `SENTRY_AUTH_TOKEN` repository secret.
- `SENTRY_ORG` / `SENTRY_PROJECT` (optional)
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    `SENTRY_ORG` and `SENTRY_PROJECT` with your Sentry slugs (for example from
    `npx @sentry/wizard@latest -i sourcemaps`).
- `CAPABILITY_REINDEX_SECRET` (optional)
  - Generate a long random secret (for example `openssl rand -hex 32`), store it
    as the repository secret `CAPABILITY_REINDEX_SECRET`, and let the deploy
    workflow sync it to the Worker. After each production deploy, CI POSTs to
    `/__maintenance/reindex-capabilities` and `/__maintenance/reindex-skills`
    with `Authorization: Bearer …` to refresh capability and user-skill
    embeddings.
- `DOCKERHUB_USERNAME`
  - Use your Docker Hub username or organization service account name.
  - Store it as the repository secret `DOCKERHUB_USERNAME`.
- `DOCKERHUB_TOKEN`
  - In Docker Hub, create an access token for image publish access.
  - Store it as the repository secret `DOCKERHUB_TOKEN`.
- `HOME_CONNECTOR_DOCKER_IMAGE`
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    `HOME_CONNECTOR_DOCKER_IMAGE` with the target Docker Hub image name (for
    example `kentcdodds/kody-home-connector`).
  - The Home Connector publish workflow pushes both `latest` and
    `sha-<shortsha>` tags to that image whenever `main` changes under
    `packages/home-connector` (or its Docker build inputs).
- Home connector runtime Sentry env (set these on the deployed container or the
  service that runs the published Docker image, not in the GitHub Actions
  workflow itself):
  - `HOME_CONNECTOR_SENTRY_DSN` (optional; enables Sentry error reporting and
    tracing for the Node-based `packages/home-connector` service)
  - `HOME_CONNECTOR_SENTRY_ENVIRONMENT` (optional; forwarded to the connector as
    `SENTRY_ENVIRONMENT`, defaults to `production` in the published Docker
    image)
  - `HOME_CONNECTOR_SENTRY_TRACES_SAMPLE_RATE` (optional `0`–`1`; forwarded to
    the connector as `SENTRY_TRACES_SAMPLE_RATE`, defaults to **`1.0`** in the
    published Docker image)
  - `APP_COMMIT_SHA` is also baked into the published Docker image and used by
    the connector’s Sentry setup as the release identifier

Preview deploys for pull requests create a separate Worker per PR named
`<app-name>-pr-<number>` (for kody: `kody-pr-123`) plus one Worker per mock
service named `<app-name>-pr-<number>-mock-<service>`. The same
`CLOUDFLARE_API_TOKEN` must be able to create/update and delete those Workers.
