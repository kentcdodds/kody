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
- Cloudflare Queue for Artifacts repository lifecycle events
  - Queue: `kody-artifacts-repo-events`
  - Dead-letter queue: `kody-artifacts-repo-events-dlq`
  - Production CI ensures both queues and reconciles an account-level
    `artifacts` event subscription for `repo.created` / `repo.deleted`.
  - Per-repo `artifacts.repo` push subscriptions (`pushed`) are created at
    runtime when durable `entity_sources` rows are ensured, using
    `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`. The Worker looks up the
    destination queue by name. Subscription ids are stored in
    `entity_source_artifacts_push_subscriptions` and deleted during artifact
    cleanup.
  - The production consumer batches at most 10 messages for 5 seconds, retries
    three times, and routes exhausted messages to the dedicated dead-letter
    queue. Consumers filter by `ARTIFACTS_NAMESPACE` and ignore session fork
    repos. Mapped package topics: `repo.pushed`, `repo.created`, `repo.deleted`.
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
- Cloudflare Queue for durable package-emitted event dispatch
  - Producer binding: `PACKAGE_EVENTS_DISPATCH_QUEUE`
  - Queue: `kody-package-events-dispatch`
  - Dead-letter queue: `kody-package-events-dispatch-dlq`
  - The production consumer uses the same batch, retry, and DLQ settings as
    platform-feedback dispatch. Production CI ensures both resources.
  - Queue messages carry the full event (emitting user, source package, topic,
    idempotency key, payload, and invocation depth). The consumer resolves the
    emitting user's subscribed packages at delivery time, invokes handlers with
    exactly-once idempotency, acknowledges terminal handler failures, and
    retries pre-execution package-invocation infrastructure failures.
  - Preview and local runtimes without this production-only queue binding
    deliver inline through the same consumer code path so package events remain
    testable.
- Cloudflare Queue for isolated scheduled maintenance
  - Producer binding: `SCHEDULED_DISPATCH_QUEUE`
  - Queue: `kody-scheduled-dispatch`
  - Dead-letter queue: `kody-scheduled-dispatch-dlq`
  - The production consumer receives one lane message per invocation, permits up
    to 16 concurrent lane invocations, retries three times, and routes exhausted
    messages to the dedicated dead-letter queue. Production CI ensures both
    resources.
  - Preview and local runtimes without this production-only queue binding run
    the same registry inline so maintenance behavior remains testable.
- Vectorize indexes for MCP capability search (`CAPABILITY_VECTOR_INDEX`)
  - Production: `kody-capabilities-prod`
  - Preview: `kody-capabilities-preview`
  - Create once per account, for example:
    `wrangler vectorize create kody-capabilities-prod --dimensions=384 --metric=cosine`
    (same for preview). **Dimensions must match** the embedding model in
    `packages/worker/src/vectorize/embedding.ts` (`@cf/baai/bge-small-en-v1.5`,
    384 dimensions, `cls` pooling).
- Workers AI binding for semantic search embeddings
  - `binding`: `AI`
  - Production and preview route embedding calls through this binding. When
    `AI_GATEWAY_ID` is configured, calls are sent through AI Gateway via the
    Workers AI binding options.
- Second registrable domain for hosted package apps
  - Production: `kodyapps.dev` (zone in the same Cloudflare account, on
    Cloudflare nameservers), attached to the production Worker as a Workers
    **custom domain**, which provisions the DNS record and edge certificate.
  - The attach happens on deploy, but the routes are **generated, not
    committed**: `writeGeneratedWranglerConfig` (`tools/ci/resource-utils.ts`)
    derives one `custom_domain` route per base-URL var (`APP_BASE_URL`,
    `APP_LEGACY_HOSTS`, and `PACKAGE_APP_BASE_URL`) while writing
    `packages/worker/wrangler-production.generated.json`. Those vars are the
    single source of truth for both the hosts the Worker routes on and the
    domains the deploy attaches, so the two cannot drift.
  - **`routes` replaces the Worker's whole custom-domain set — it does not add
    to it.** Omitting a previously attached custom domain detaches that origin
    and deletes its DNS record. The generator therefore always lists the app
    origin alongside the package-app origin, and fails the deploy when
    `PACKAGE_APP_BASE_URL` is set without `APP_BASE_URL` rather than publishing
    a partial set. Any domain attached out-of-band must be added here before the
    next deploy, or that deploy will remove it. During a domain migration the
    previous app host must therefore be listed in the `APP_LEGACY_HOSTS`
    repository variable (comma-separated bare hostnames, e.g. `heykody.dev`)
    before `APP_BASE_URL` flips to the new domain, so the old origin stays
    attached and dual-served.
  - Publishing routes also flips `workers_dev` to `false`, which silently drops
    the `<name>.<subdomain>.workers.dev` trigger (Cloudflare then answers that
    hostname with error 1042). The generator sets `workers_dev: true` alongside
    the routes so that backup access path — which MCP clients may point at, and
    which the deploy's URL fallback looks for — survives.
  - The routes deliberately do **not** live in `packages/worker/wrangler.jsonc`:
    `npm run dev` runs `wrangler dev` against the **production** environment,
    and Wrangler resolves local request URLs against the first configured route,
    so a committed route makes every local request arrive as
    `http://kodyapps.dev/...` — canonical URLs, OAuth resource metadata, and
    login redirects then point at the production domain from localhost.
  - Attaching a custom domain needs a deploy token with edit access to the
    target zone. Without it the deploy step fails on the custom domain instead
    of silently skipping it.
  - The domain exists to be a **different registrable domain** from the app
    origin so author-supplied package code is cross-site. Do not point it at a
    subdomain of the app origin, and do not host anything first-party on it. See
    [Hosted package app origin isolation](./security.md#hosted-package-app-origin-isolation).
  - Production forks must register a second domain and set
    `PACKAGE_APP_BASE_URL`; package-app requests return `500` when it is missing
    or not on a separate registrable domain. Confirmed local, preview, and test
    runtimes may leave it unset and use inline serving.
- Workers Observability OTLP destination (account-level)
  - Workers automatic tracing is enabled via `observability.traces` in
    `packages/worker/wrangler.jsonc`; traces are viewable in the Workers
    Observability dashboard with no further setup.
  - Production traces are additionally exported to Sentry through the
    account-level **Traces** destination `sentry-otlp-traces`, referenced from
    `observability.traces.destinations` in the **production** environment only
    (preview and test deploys keep dashboard-only tracing). In the production
    Cloudflare account it points at the `kody-cloudflare` Sentry project's OTLP
    endpoint (`https://<HOST>/api/<PROJECT_ID>/integration/otlp/v1/traces` with
    the `x-sentry-auth: sentry sentry_key=<public key>` header derived from the
    project DSN).
  - Forks must create their own destination under the same name, or remove the
    `destinations` line — deploys can fail on unknown destinations. Create it in
    the dashboard (**Workers Observability → Destinations**, type Traces) or via
    the API:

    ```sh
    curl -X POST \
      "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/observability/destinations" \
      -H "Authorization: Bearer <API_TOKEN>" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "sentry-otlp-traces",
        "enabled": true,
        "configuration": {
          "type": "logpush",
          "logpushDataset": "opentelemetry-traces",
          "url": "https://<HOST>/api/<PROJECT_ID>/integration/otlp/v1/traces",
          "headers": { "x-sentry-auth": "sentry sentry_key=<public key>" }
        }
      }'
    ```

  - Production pins `SENTRY_TRACES_SAMPLE_RATE` to `0` (Wrangler var) so the
    Sentry SDK does not duplicate the exported traces; see
    [environment-variables.md](./environment-variables.md).

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

Production backup **resources** (R2 bucket locks/lifecycle) are still
provisioned out-of-band with `tools/ci/backup-resources-cli.ts`. The
control-plane Worker/Workflows under `packages/backup-control-plane/` live in
the independently administered DR Cloudflare account. Its `BACKUP_BUCKET` R2
binding is private. Immutable prefixes include `daily/`, `weekly/`,
`daily/full/`, and content-addressed `blobs/sha256/`.

Code deploys are automated by the production deploy workflow
(`.github/workflows/deploy.yml` job `deploy-backup-control-plane`) when a `main`
push changes `packages/backup-control-plane/` or `packages/shared/src/backup-*`,
and on every manual `workflow_dispatch` of that workflow. The job uses
`DR_DEPLOY_TOKEN` + `DR_BACKUP_ACCOUNT_ID` (never the production-account
`CLOUDFLARE_API_TOKEN`) and sets `BUILD_COMMIT` to the deploy SHA. Worker
secrets on the control plane remain one-time / out-of-band.

The production Worker also stages non-D1 canonical stores into the same bucket
when `DR_EXPORT_ENABLED=true` (StorageRunner dumps, `EMAIL_BLOBS` /
`COMMUNITY_ASSETS` blobs, published `BUNDLE_ARTIFACTS_KV` source snapshots). The
control plane seals complete days and hosts the Access-protected Admin UI for
drills and graduated production restore. See
[Disaster recovery](./disaster-recovery.md).

Use a separate provisioner token (never a Worker secret) to create the bucket
and apply 35-day daily and 400-day weekly lock/lifecycle rules:

```sh
node tools/ci/backup-resources-cli.ts plan \
  --source-account-id "<PRODUCTION_ACCOUNT_ID>" \
  --destination-account-id "<DR_ACCOUNT_ID>" \
  --source-d1 "<PRODUCTION_D1_UUID>:kody" \
  --deny-production-resource kody-email-blobs \
  --deny-production-resource kody-community-assets
```

`apply` is an explicit mutation and must be run only after reviewing the plan.
The control-plane runtime receives a source-account token with Cloudflare
Account D1 Edit as `CLOUDFLARE_API_TOKEN` (export + production D1 import).
Cloudflare grants this permission account-wide and it can mutate D1; the
runtime's UUID/name allowlist reduces mistakes but does not scope the token.
Keep that token separate from the provisioner token, drill token
(`DRILL_API_TOKEN`), and production→DR S3 credentials on the app Worker.
Scheduling remains inert until the blocking-export benchmark is approved and
both `ENABLE_PRODUCTION_D1_BACKUPS` and `BACKUP_BENCHMARK_APPROVED` are exactly
`"true"`.

Reviewed non-secret control-plane vars include manifest signing key id /
verifying public key, trusted restore baseline id/digest, Access
(`ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`, `ACCESS_ALLOWED_EMAIL`),
`DRILL_ACCOUNT_ID`, and `PRIMARY_WORKER_ORIGIN`. Worker secrets include
`BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, `DRILL_API_TOKEN`,
`RESTORE_CONFIRM_SECRET`, and `DR_RESTORE_SECRET`. Never commit private keys.
Offline CLI restore still trusts only the checked-in manifest public-key,
production-identity, and restore-baseline registries.

### Status page worker

The public status page (`packages/status/`, served at `status.heykody.dev` via a
wrangler custom domain on the production zone) is an independently deployed
Worker with a cron trigger and one `StatusStore` Durable Object (SQLite). It
probes public endpoints on the main worker and `kodyapps.dev` every minute and
never touches `APP_DB` (see decision record
[0004](./decisions/0004-status-page-separate-worker.md)).

Code deploys are automated by the production deploy workflow
(`.github/workflows/deploy.yml` job `deploy-status-worker`) when a `main` push
changes `packages/status/`, and on every manual `workflow_dispatch` of that
workflow. The job deploys with the production-account `CLOUDFLARE_API_TOKEN`,
sets `BUILD_COMMIT` to the deploy SHA, and syncs the same token as the Worker
secret `CLOUDFLARE_API_TOKEN` so the status worker can send operator alert email
through the Cloudflare Email REST API (from `ALERT_EMAIL_FROM` to
`ALERT_EMAIL_TO`, both non-secret vars in `packages/status/wrangler.jsonc`).
Without that secret, alert sends are skipped and logged.

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
  URL is available — e.g. workflows and email. Example `https://heykody.app`.
  Most request-scoped app/MCP URLs use the inbound request origin so OAuth
  metadata matches the host the client connected to. Password reset email sends
  require a system email domain and use `kody@<domain>` as the sender — the
  `SYSTEM_EMAIL_DOMAIN` override when set, otherwise the `APP_BASE_URL`
  hostname.)
- `PACKAGE_APP_BASE_URL` (Wrangler `var`; required in production and optional
  for confirmed local/preview/test runtimes; origin for hosted package apps.
  Production sets `https://kodyapps.dev` in `packages/worker/wrangler.jsonc`,
  and the deploy attaches that host as a Workers custom domain from the
  generated config (see the Cloudflare resources list above). Must be a
  **separate registrable domain** from `APP_BASE_URL` — see
  [Hosted package app origin isolation](./security.md#hosted-package-app-origin-isolation).
  Local dev ignores any value it cannot serve itself, and preview/test leave it
  unset, so those keep serving package apps inline on the app origin. Point it
  at `http://packages.localhost:<port>` in `packages/worker/.env` to exercise
  the two-origin flow locally.)
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
  when unset; production pins `0` via a Wrangler var — see
  [environment-variables.md](./environment-variables.md))
- `FATHOM_SITE_ID` (optional public Wrangler var; when set, SSR pages embed the
  Fathom Analytics tracker script. Committed for production in
  `packages/worker/wrangler.jsonc`; intentionally unset for local dev, preview,
  and tests — see [environment-variables.md](./environment-variables.md))
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
- `CAPABILITY_REINDEX_SECRET` (strongly recommended for production — CI skips
  the post-deploy reindex and execute smoke check when unset; optional locally
  and for previews; bearer auth for `POST /__maintenance/reindex-capabilities`
  to refresh all capability-search vectors in Vectorize: built-in capabilities,
  memories, jobs, and saved packages. Saved package projections also refresh
  when packages are saved or published.)
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`, `X_CLIENT_ID` / `X_CLIENT_SECRET` (optional Worker
  secrets; enable the "Sign in with GitHub / Google / X" login buttons. A
  `MOCK_`-prefixed client id activates the in-worker mock flow on non-production
  runtimes. See `docs/contributing/social-login.md`.)
- `STRIPE_SECRET_KEY` (optional Worker secret; enables Stripe checkout linking,
  billing portal, and `users.stripe_plan` refresh. When unset, billing degrades
  to manual plans.)
- `STRIPE_WEBHOOK_SECRET` (optional Worker secret; Stripe webhook signing secret
  for `POST /webhooks/stripe`. When unset, the webhook endpoint returns 503.)
- `STRIPE_API_BASE_URL` (optional; defaults to `https://api.stripe.com`.
  Override for tests/mocks.)
- `STRIPE_STANDARD_PRICE_ID` (optional public Wrangler var committed in
  `packages/worker/wrangler.jsonc`; Stripe Price id mapped to the $5/month
  `standard` plan and used for authenticated Checkout Sessions.)
- `STRIPE_PRO_PRICE_ID` (optional public Wrangler var committed in
  `packages/worker/wrangler.jsonc`; Stripe Price id mapped to the $20/month
  `pro` plan and used for authenticated Checkout Sessions.) Each price id is
  independent; an unset value only disables checkout for that tier.

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
- `SECRET_STORE_KEY` (same format as local; required for deploys; also sealed
  into the DR bucket via `.github/workflows/dr-escrow.yml` using
  `SECRET_ESCROW_PASSPHRASE` plus `DR_BACKUP_*` S3 credentials — see
  [Disaster recovery](./disaster-recovery.md))
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
- `CAPABILITY_REINDEX_SECRET` (strongly recommended for production; optional
  locally and for previews; authenticates post-deploy maintenance calls such as
  capability reindex — CI skips those calls when it is unset)
- `DR_BACKUP_ACCOUNT_ID` / `DR_BACKUP_BUCKET_NAME` / `DR_BACKUP_ACCESS_KEY_ID` /
  `DR_BACKUP_SECRET_ACCESS_KEY` (production DR staging into the DR bucket; also
  used by `.github/workflows/dr-escrow.yml`. `DR_BACKUP_ACCOUNT_ID` is also the
  Cloudflare account id for control-plane deploys. Pair with Worker var
  `DR_EXPORT_ENABLED=true` only after enablement — see
  [Disaster recovery](./disaster-recovery.md))
- `DR_DEPLOY_TOKEN` (DR-account API token for `deploy-backup-control-plane` in
  `.github/workflows/deploy.yml`. Needs Workers Scripts Edit/Read, Account
  Workers Scripts Edit, and Workflows Edit on the DR account only — keep
  separate from production `CLOUDFLARE_API_TOKEN`)
- `DR_RESTORE_SECRET` (shared bearer for control-plane →
  `POST /__maintenance/dr-restore`)
- `SECRET_ESCROW_PASSPHRASE` (operator passphrase for sealing `SECRET_STORE_KEY`
  into `escrow/secret-store-key.v1.json`; keep the same value in the personal
  password manager)
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
  for account billing. Production deploy syncs it when set. The Standard and Pro
  price ids are public Wrangler vars committed in
  `packages/worker/wrangler.jsonc`, not GitHub secrets.)
- `STRIPE_WEBHOOK_SECRET` (optional GitHub / Worker secret; Stripe endpoint
  signing secret (`whsec_...`) for platform billing webhooks at
  `POST /webhooks/stripe`. Production deploy syncs it when set.)
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
  - Use your production app URL (for example `https://heykody.app`) as the
    fallback public origin for workflows and password-reset email.
  - Add it when password reset email should send; the sender is
    `kody@<system email domain>` (the `SYSTEM_EMAIL_DOMAIN` override when set,
    otherwise the `APP_BASE_URL` hostname), so verify that sender/domain in
    Cloudflare Email Service.
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
  - Production also commits `USER_EMAIL_DOMAIN=inbox.heykody.app` (and
    `SYSTEM_EMAIL_DOMAIN=heykody.app`) in `packages/worker/wrangler.jsonc` so
    the email domains can never silently rederive from `APP_BASE_URL`; the
    deploy tooling reads the same committed pin. During the heykody.dev
    migration window (through end of August 2026) the committed
    `LEGACY_USER_EMAIL_DOMAINS=inbox.heykody.dev` and
    `LEGACY_SYSTEM_EMAIL_DOMAINS=heykody.dev` keep inbound mail to the old
    addresses resolving to the same inboxes; empty the lists (and retire the
    `heykody.dev` email DNS) after the window ends.
- `APP_LEGACY_HOSTS` / `APP_LEGACY_REDIRECT` (optional GitHub Actions
  **variables** for domain migrations; see
  [environment-variables.md](./environment-variables.md#app-origin-and-domain-migration)).
  - `APP_LEGACY_HOSTS` lists previous app hostnames (comma-separated, e.g.
    `heykody.dev`) that stay attached to the Worker as custom domains and are
    dual-served.
  - `APP_LEGACY_REDIRECT=true` enables 308 redirects for browser GET/HEAD
    navigation from those hosts to the canonical origin; protocol surfaces
    (`/mcp`, OAuth, well-known, auth callbacks, webhooks, health) always keep
    serving directly.
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
- `CAPABILITY_REINDEX_SECRET` (strongly recommended for production; optional
  locally and for previews)
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
