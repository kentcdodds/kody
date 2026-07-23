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
  - Production domains need Cloudflare-side sender/domain verification before
    sends succeed.
- Cloudflare Email Routing for inbound mail
  - Configure MX records and selected route aliases in the Cloudflare dashboard.
  - Route only aliases that should persist inbound mail to the Worker.
- Cloudflare Queue for Email Sending delivery events
  - Production CI ensures `kody-email-delivery` and `kody-email-delivery-dlq`,
    then reconciles an `email.sending` event subscription for the configured
    user email domain.
  - The API token needs `Workers Queues:Edit`; the domain must already be
    enabled for Cloudflare Email Sending.
- Cloudflare Queue for durable platform-feedback subscription dispatch
  - Producer binding: `PLATFORM_FEEDBACK_DISPATCH_QUEUE`
  - Queue: `kody-platform-feedback-dispatch`
  - Dead-letter queue: `kody-platform-feedback-dispatch-dlq`
  - The production consumer batches at most 10 messages for 5 seconds, retries
    three times, and routes exhausted messages to the dedicated dead-letter
    queue. Production CI ensures both resources.
  - Queue messages contain only `{ feedbackId }`. The consumer reloads current
    feedback metadata, acknowledges invalid or deleted ids, and retries
    transient load, subscription-discovery, or package-invocation wrapper
    infrastructure failures before routing exhausted messages to the DLQ. Stored
    failures replay under the same idempotency key rather than automatically
    rerunning; terminal handler execution failures stay isolated.
- Cloudflare Queue for durable community-activity subscription dispatch
  - Producer binding: `COMMUNITY_ACTIVITY_DISPATCH_QUEUE`
  - Queue: `kody-community-activity-dispatch`
  - Dead-letter queue: `kody-community-activity-dispatch-dlq`
  - The production consumer uses the same batch, retry, and DLQ settings as
    platform-feedback dispatch. Production CI ensures both resources.
  - Queue messages contain only `{ eventId, kind, activityId }`. The consumer
    reloads the metadata-only activity projection, acknowledges invalid or
    deleted activity, and retries transient lookup, subscription-discovery, or
    package-invocation infrastructure failures.
- Vectorize indexes for MCP capability search (`CAPABILITY_VECTOR_INDEX`)
  - Production: `kody-capabilities-prod`
  - Preview: `kody-capabilities-preview`
  - Create once per account, for example:
    `wrangler vectorize create kody-capabilities-prod --dimensions=384 --metric=cosine`
    (same for preview). **Dimensions must match** the embedding model in
    `packages/worker/src/mcp/capabilities/capability-search.ts`
    (`@cf/baai/bge-small-en-v1.5`, 384 dimensions, `cls` pooling).
- Workers AI binding for semantic search embeddings
  - `binding`: `AI`
  - Production and preview route embedding calls through this binding. When
    `AI_GATEWAY_ID` is configured, calls are sent through AI Gateway via the
    Workers AI binding options.

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

### Disaster-recovery control plane

Production backups use a separate deployment and are not provisioned or deployed
by the application workflow above. The dedicated Worker and Workflow live under
`packages/backup-control-plane/` in an independently administered DR Cloudflare
account. Its `BACKUP_BUCKET` R2 binding is private and uses immutable `daily/`
and `weekly/` prefixes.

The retention administrator uses a separate provisioner token to create the
bucket and apply 35-day daily and 400-day weekly lock/lifecycle rules:

```sh
node tools/ci/backup-resources-cli.ts plan \
  --source-account-id "<PRODUCTION_ACCOUNT_ID>" \
  --destination-account-id "<DR_ACCOUNT_ID>" \
  --source-d1 "<PRODUCTION_D1_UUID>:kody" \
  --deny-production-resource kody-email-blobs \
  --deny-production-resource kody-community-assets
```

`apply` is an explicit mutation and must be run only after reviewing the plan.
The runtime receives a source-account token with Cloudflare Account D1 Edit as
the `CLOUDFLARE_API_TOKEN` Worker secret. Cloudflare grants this permission
account-wide and it can mutate D1; the runtime's application UUID/name allowlist
reduces operator mistakes but does not technically scope the token to one
database or make it read-only. Keep this source runtime token separate from the
destination R2 provisioning/lock-administration token and drill restore
credentials. The runtime must not receive either of those credentials or R2
bucket, lock, lifecycle, or public-access administration permissions. Scheduling
remains inert until the blocking-export benchmark is approved and both enable
variables are exactly `true`. See [Disaster recovery](./disaster-recovery.md)
for deployment, readiness, drill, credential, and exclusion details.

The backup deployment also requires reviewed non-secret
`BACKUP_MANIFEST_SIGNING_KEY_ID`, `TRUSTED_RESTORE_BASELINE_ID`, and
`TRUSTED_RESTORE_BASELINE_SHA256` vars. Store the matching base64-encoded
Ed25519 PKCS#8 private key only as the
`BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64` Worker secret. Never commit
that private key. Restore trusts only the checked-in manifest public-key,
production-identity, and restore-baseline registries.

## Optional Cloudflare offerings

The default footprint stays intentionally small. If you want to add additional
Cloudflare offerings (R2, Workers AI, AI Gateway, or a separate KV namespace for
app data), see:

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
- `SECRET_STORE_KEY` (required; generate with `openssl rand -base64 48`)
- `APP_BASE_URL` (optional; used as the fallback public origin when no request
  URL is available — e.g. workflows and email. Example `https://heykody.dev`.
  Most request-scoped app/MCP URLs use the inbound request origin so OAuth
  metadata matches the host the client connected to. Password reset email sends
  require this value and use `kody@<hostname>` as the sender.)
- `APP_COMMIT_SHA` (optional; set automatically by deploy workflows for
  version-aware `/health` checks)
- `CLOUDFLARE_ACCOUNT_ID` (required for the Cloudflare Email Service REST API
  fallback used by local mocks and preview deploys)
- `CLOUDFLARE_API_TOKEN` (used by the Cloudflare Email Service REST API fallback
  when local/preview email is routed through the Cloudflare mock or API)
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
- `ARTIFACTS_NAMESPACE` (optional Worker var; defaults to `default`. Set per
  Wrangler environment in `packages/worker/wrangler.jsonc` — e.g. `production`
  and `preview` — so Artifacts repos are partitioned by deploy environment.)
- `AI_GATEWAY_ID` (optional Worker secret; routes Workers AI embedding calls
  through the configured Cloudflare AI Gateway when set)
- `CAPABILITY_REINDEX_SECRET` (required in production; optional locally and for
  previews; bearer auth for `POST /__maintenance/reindex-capabilities` to
  refresh all capability-search vectors in Vectorize: built-in kody, memories,
  jobs, and saved packages. Saved package projections also refresh when packages
  are saved or published.)
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`, `X_CLIENT_ID` / `X_CLIENT_SECRET` (optional Worker
  secrets; enable the "Sign in with GitHub / Google / X" login buttons. A
  `MOCK_`-prefixed client id activates the in-worker mock flow on non-production
  runtimes. See `docs/contributing/social-login.md`.)
- `STRIPE_SECRET_KEY` (optional Worker secret; enables Stripe checkout linking,
  billing portal, and `users.stripe_plan` refresh. When unset, billing degrades
  to manual plans.)
- `STRIPE_API_BASE_URL` (optional; defaults to `https://api.stripe.com`.
  Override for tests/mocks.)
- `STRIPE_PRO_PRICE_ID` (optional Worker var; Stripe Price id mapped to the
  `pro` plan and used for authenticated Checkout Sessions. Production value is
  set in `packages/worker/wrangler.jsonc`.)

Tests run with `CLOUDFLARE_ENV=test` (set by Playwright) and read local secrets
from `packages/worker/.env`.

## GitHub Actions configuration

Configure these GitHub Actions secrets and variables for workflows:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account; also reused for remote AI and Cloudflare API workflows that run with
  account secrets + package workflows)
- `CLOUDFLARE_ACCOUNT_ID` (required GitHub Actions **variable** for Cloudflare
  resource provisioning and Email Service)
- `CLOUDFLARE_ZONE_ID` (required GitHub Actions **variable** for the zone that
  owns the user email sending domain; Email Sending event subscriptions require
  both this zone id and the domain)
- `COOKIE_SECRET` (same format as local)
- `SECRET_STORE_KEY` (same format as local; required for deploys)
- `APP_BASE_URL` (required GitHub Actions **variable** used by the deployed
  Worker as the fallback public app origin when no request URL is available —
  workflows, password-reset email sender hostname — and written into the
  generated Worker `vars` config before deploy. Request-scoped MCP/app URLs use
  the inbound request origin.)
- `AI_GATEWAY_ID` (optional for production deploys; enables AI Gateway routing
  for Workers AI embeddings)
- `AI_GATEWAY_ID_PREVIEW` (optional for preview deploys; enables AI Gateway
  routing for Workers AI embeddings)
- `SENTRY_DSN` (optional; create a JavaScript/Cloudflare project in Sentry and
  paste the DSN; syncs to the Worker as a secret when set in GitHub Actions)
- `CAPABILITY_REINDEX_SECRET` (required in production; optional locally and for
  previews; authenticates post-deploy maintenance calls such as capability
  reindex)
- `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET`,
  `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_X_CLIENT_ID` /
  `OAUTH_X_CLIENT_SECRET` (optional; social login provider app credentials. The
  production deploy workflow syncs them to the Worker as the unprefixed
  `GITHUB_CLIENT_ID`-style secrets — the `OAUTH_` prefix exists because GitHub
  Actions reserves the `GITHUB_*` secret namespace. See
  `docs/contributing/social-login.md` for provider app setup.)
- `KIT_API_KEY` (optional GitHub / Worker secret; Kit / kit.com API key for
  `/waiting-list` signup and best-effort `signed_up::kody` tagging on account
  signup when the email already exists in Kit. Production deploy syncs it when
  set; without it, production waiting-list joins return 503 while the rest of
  the app still deploys (account signup simply skips Kit tagging). Preview
  deploys intentionally omit the key so preview/E2E joins do not write to the
  production Kit audience. Create a Kit API key at
  https://app.kit.com/account_settings/developer_settings and use the same value
  as the Kody user secret `kitApiKey` when convenient.)
- `STRIPE_SECRET_KEY` (optional GitHub / Worker secret; Stripe secret API key
  for account billing. Production deploy syncs it when set. The Pro price id is
  a Worker var committed in `packages/worker/wrangler.jsonc`, not a GitHub
  secret.)
- `SENTRY_AUTH_TOKEN` (optional GitHub **secret**; Sentry auth token with
  `project:releases` / source map upload permissions — used only by CI to run
  `npm run sentry:upload-sourcemaps` after deploy)
- **Repository variables** `SENTRY_ORG` and `SENTRY_PROJECT` (optional; Sentry
  organization and project **slugs** for source map upload — same values as in
  the Sentry wizard’s `--org` / `--project` flags)

How to get/set each value:

- `CLOUDFLARE_API_TOKEN`
  - In Cloudflare Dashboard, create an API Token with permissions to deploy
    Workers and edit D1 on the target account. This is the same token to reuse
    for remote AI and Cloudflare API workflows that run with account secrets and
    saved packages; when you do, also include the product permissions needed for
    those APIs.
  - In GitHub: `Settings` → `Secrets and variables` → `Actions` →
    `New repository secret`.
- `COOKIE_SECRET`
  - Generate locally: `openssl rand -hex 32`
  - Store the exact value as a repository secret in GitHub Actions.
- `APP_BASE_URL` (optional)
  - Use your production app URL (for example `https://heykody.dev`) as the
    fallback public origin for workflows and password-reset email.
  - Add it when password reset email should send; the sender is derived as
    `kody@<hostname>`, so verify that sender/domain in Cloudflare Email Service.
  - It also lets deploy-time health/version checks use a fixed URL.
  - Production CI writes this into the generated Wrangler `vars` config before
    deploy, rather than syncing it as a Worker secret.
  - Request-scoped MCP/app URLs use the inbound request origin so OAuth resource
    metadata matches the host the client connected to.
  - Do not also upload `APP_BASE_URL` through `wrangler secret bulk` or pass it
    as a deploy-time `--var`, because Wrangler treats that as a conflicting
    binding name.
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID`
  - Copy both identifiers from the Cloudflare dashboard overview for the
    production zone.
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    each under its exact name.
- `USER_EMAIL_DOMAIN` (optional GitHub Actions **variable**; overrides
  `inbox.<APP_BASE_URL hostname>` for user inboxes, outbound senders, and the
  Email Sending event subscription).
  - In GitHub: **Settings → Secrets and variables → Actions → Variables**, add
    it only when the production user email domain differs from the default.
- `AI_GATEWAY_ID`
  - Create a Cloudflare AI Gateway in the dashboard and copy its production
    gateway ID. The Worker uses this for Workers AI embedding calls when set;
    leave unset only if direct Workers AI calls are preferred.
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
- `CAPABILITY_REINDEX_SECRET` (required in production; optional locally and for
  previews)
  - Generate a long random secret (for example `openssl rand -hex 32`), store it
    as the repository secret `CAPABILITY_REINDEX_SECRET`, and let the deploy
    workflow sync it to the Worker. After each production deploy, CI POSTs to
    `/__maintenance/reindex-capabilities` with `Authorization: Bearer …` to
    refresh built-in capability, memory, job, and saved-package embeddings. Run
    the same POST manually after changing the embedding model, pooling, or
    Vectorize index dimensions so existing rows are rebuilt with compatible
    vectors. Local and preview environments can omit it; CI skips reindex and
    execute-smoke when the secret is unset.

Preview deploys for pull requests create a separate Worker per PR named
`<app-name>-pr-<number>` (for kody: `kody-pr-123`) plus one Worker per mock
service named `<app-name>-pr-<number>-mock-<service>`. The same
`CLOUDFLARE_API_TOKEN` must be able to create/update and delete those Workers.
