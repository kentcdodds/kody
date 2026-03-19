# Setup manifest

This document describes the infrastructure and secrets that kody expects.

## Cloudflare resources

This project uses the following resources:

- D1 database
  - `database_name`: `<app-name>`
- KV namespace for OAuth/session storage
  - `binding`: `OAUTH_KV`
  - `title`: `<app-name>-oauth`

Production CI deploys now ensure these resources exist and create them when
missing. The post-download script does not create Cloudflare resources and does
not rewrite `wrangler.jsonc` resource IDs. Cloudflare deploys do not auto-create
these resources from bindings alone, so the deploy workflow runs
`bun tools/ci/production-resources.ts ensure` first.

## Optional Cloudflare offerings

The starter intentionally keeps the default footprint small. If you want to add
additional Cloudflare offerings (R2, Workers AI, AI Gateway, or a separate KV
namespace for app data), see:

- `docs/cloudflare-offerings.md`

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

Local development uses `.env`, which Wrangler loads automatically:

- `COOKIE_SECRET` (generate with `openssl rand -hex 32`)
- `APP_BASE_URL` (optional; defaults to request origin, example
  `https://app.example.com`)
- `APP_COMMIT_SHA` (optional; set automatically by deploy workflows for
  version-aware `/health` checks)
- `RESEND_API_BASE_URL` (optional, defaults to `https://api.resend.com`)
- `RESEND_API_KEY` (optional, required to send via Resend)
- `RESEND_FROM_EMAIL` (optional, required to send via Resend)
- `AI_GATEWAY_ID` (required when `AI_MODE=remote`; deploy workflows sync a
  gateway ID from GitHub Actions secrets so remote inference goes through
  Cloudflare AI Gateway)
- `CLOUDFLARE_ACCOUNT_ID` (required for local development when `AI_MODE=remote`
  so Wrangler can authenticate Workers AI requests against the correct account)
- `CLOUDFLARE_API_TOKEN` (required for local development when `AI_MODE=remote`
  so Wrangler can authenticate Workers AI requests)
- `SENTRY_DSN` (optional Cloudflare Worker secret; enables error reporting and
  tracing for the Worker and Durable Objects)
- `SENTRY_ENVIRONMENT` (set per deploy via `wrangler.jsonc` `vars` as
  `production`, `preview`, or `test`; optional override via env for local dev)
- `SENTRY_TRACES_SAMPLE_RATE` (optional `0`–`1`, defaults to **`1.0`** in code
  when unset — full sampling for low traffic; lower if volume grows)
- `APP_COMMIT_SHA` (used as the Sentry **release** when present, in addition to
  `/health` versioning)

Tests run with `CLOUDFLARE_ENV=test` (set by Playwright) and still read local
secrets from `.env`.

## GitHub Actions configuration

Configure these GitHub Actions secrets and variables for workflows:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account)
- `COOKIE_SECRET` (same format as local)
- `APP_BASE_URL` (optional GitHub Actions **variable**, used by the production
  deploy)
- `AI_GATEWAY_ID` (required for production deploys that use remote AI inference)
- `AI_GATEWAY_ID_PREVIEW` (required for preview deploys that use remote AI
  inference)
- `RESEND_API_KEY` (optional, required to send via Resend in non-mock
  environments)
- `RESEND_FROM_EMAIL` (optional, required to send via Resend)
- `SENTRY_DSN` (optional; create a JavaScript/Cloudflare project in Sentry and
  paste the DSN; syncs to the Worker as a secret when set in GitHub Actions)
- `SENTRY_AUTH_TOKEN` (optional GitHub **secret**; Sentry auth token with
  `project:releases` / source map upload permissions — used only by CI to run
  `bun run sentry:upload-sourcemaps` after deploy)
- **Repository variables** `SENTRY_ORG` and `SENTRY_PROJECT` (optional; Sentry
  organization and project **slugs** for source map upload — same values as in
  the Sentry wizard’s `--org` / `--project` flags)

How to get/set each value:

- `CLOUDFLARE_API_TOKEN`
  - In Cloudflare Dashboard, create an API Token with permissions to deploy
    Workers and edit D1 on the target account.
  - In GitHub: `Settings` → `Secrets and variables` → `Actions` →
    `New repository secret`.
- `COOKIE_SECRET`
  - Generate locally: `openssl rand -hex 32`
  - Store the exact value as a repository secret in GitHub Actions.
- `APP_BASE_URL` (optional)
  - Use your production app URL (for example `https://app.example.com`).
  - Add only if you want deploy-time health/version checks to use a fixed URL.
- `AI_GATEWAY_ID`
  - Create a Cloudflare AI Gateway in the dashboard and copy its production
    gateway ID.
  - Store that value as the production GitHub Actions secret.
- `AI_GATEWAY_ID_PREVIEW`
  - Create a separate Cloudflare AI Gateway for previews and copy its gateway
    ID.
  - Store that value as the preview GitHub Actions secret so preview deploys
    sync a different worker secret than production.
- `RESEND_API_KEY` (optional)
  - Create in Resend Dashboard (API keys), then store in GitHub Actions secrets.
- `RESEND_FROM_EMAIL` (optional)
  - Use your verified sender/from address in Resend (for example
    `noreply@example.com`), then store it as a secret.
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

Preview deploys for pull requests create a separate Worker per PR named
`<app-name>-pr-<number>` (for kody: `kody-pr-123`) plus one Worker per mock
service named `<app-name>-pr-<number>-mock-<service>`. The same
`CLOUDFLARE_API_TOKEN` must be able to create/update and delete those Workers.
