# Environment variables

Use this guide when you add a new environment variable to the worker app. It
keeps types, runtime validation, and documentation in sync.

## Steps

1. **Add the type**
   - Update `packages/worker/src/env-schema.ts` so the worker schema and
     `AppEnv` include the new variable.
   - `packages/worker/env.d.ts` extends `Env` from that worker-owned schema.

2. **Validate at runtime**
   - Add the variable to the runtime schema in
     `packages/worker/src/env-schema.ts`.
   - `packages/worker/src/app/env.ts` uses the schema to fail fast at runtime.
   - The schema is the single source of truth for validation + types.

   The schema is built with `remix/data-schema` (`createSchema`, `object`,
   `string`), not Zod. Example:

   ```ts
   export const EnvSchema = object({
   	COOKIE_SECRET: string().refine(
   		(value) => value.length >= 32,
   		'COOKIE_SECRET must be at least 32 characters for session signing.',
   	),
   	THIRD_PARTY_API_KEY: string().refine(
   		(value) => value.length > 0,
   		'Missing THIRD_PARTY_API_KEY. Go to https://example.com/ to get one.',
   	),
   })
   ```

3. **Add local defaults**
   - Update `packages/worker/.env.example` (source for new local
     `packages/worker/.env` files).

4. **Update required resources docs**
   - Add the variable to `docs/contributing/setup-manifest.md`.

5. **Sync deploy config**
   - Add the variable to the relevant GitHub Actions workflows so it is passed
     to Wrangler as a Worker var or secret, depending on sensitivity:
     - `.github/workflows/deploy.yml` (production deploys)
     - `.github/workflows/preview.yml` (preview deploys)

## Sentry

Optional Worker secret and vars (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/sentry-options.ts`):

- `SENTRY_DSN` — ingest URL from your Sentry project. When unset, the Worker
  skips `Sentry.withSentry`; Durable Objects use the same options builder and
  will not send events without a DSN. The DSN (a publishable client key) is also
  exposed to the browser via the `kody:sentry` meta tag to enable client error
  capture and error-only session replay through the same-origin `/sentry-tunnel`
  route.
- `SENTRY_ENVIRONMENT` — also set as a Wrangler `var` per environment in
  `packages/worker/wrangler.jsonc` for deploys.
- `SENTRY_TRACES_SAMPLE_RATE` — optional `0`–`1`; defaults to **`1.0`** (sample
  all traces) when unset. Production pins it to `0` as a Wrangler `var` in
  `packages/worker/wrangler.jsonc` because Workers native tracing already
  exports OTLP traces to Sentry and duplicate SDK traces would double quota
  usage; error reporting is unaffected. The Sentry options builder reads the raw
  runtime env and only honors a **number**, so configure it as a JSON-number
  `var`, not a string secret.

## Fathom Analytics

Optional Wrangler `var` (public, non-secret; see
`packages/worker/src/env-schema.ts` and
`packages/worker/src/app/ssr-document.tsx`):

- `FATHOM_SITE_ID` — the Fathom Analytics site id. When set, SSR pages embed the
  Fathom tracker script (`https://cdn.usefathom.com/script.js` with
  `data-spa="auto"` so SPA navigations are tracked). Production sets it in
  `packages/worker/wrangler.jsonc`; it is intentionally unset for local dev,
  preview, and tests so those environments never send pageviews. The CSP in
  `packages/worker/src/app/security-headers.ts` allowlists
  `https://cdn.usefathom.com` in `script-src` and `img-src` for the tracker and
  its image beacon.

## App origin and domain migration

Wrangler `vars` (public and non-secret; see
`packages/worker/src/app-base-url.ts`,
`packages/worker/src/app-legacy-redirect.ts`, and `tools/ci/resource-utils.ts`):

- `APP_BASE_URL` — the canonical public app origin (`https://kody.codes` in
  production, set as a GitHub Actions repository variable and injected by the
  deploy). Unset for local dev and set to the ephemeral worker URL for previews.
  The deploy derives a Workers `custom_domain` route from it, and
  `getCanonicalAppBaseUrl` uses it for canonical/OG URLs in SSR HTML.
- `APP_LEGACY_HOSTS` — optional comma-separated additional app hostnames (for
  example `heykody.dev`) that remain attached and dual-served alongside
  `APP_BASE_URL`. The generated deploy `routes` list **replaces** the Worker's
  entire custom-domain set, so every dual-served host must be listed here —
  otherwise the next deploy detaches omitted origins and deletes their DNS
  records. Set as a GitHub Actions repository variable.
- `APP_LEGACY_REDIRECT` — exact string `true` enables path-and-query-preserving
  `308` redirects from legacy hosts to the canonical origin for browser GET/HEAD
  navigation only. Protocol surfaces are never redirected: `/mcp` (clients POST
  and do not follow redirects), `/oauth/*` and `/.well-known/*` (origin-exact
  metadata, Tesla public key), `/auth/*` and `/webauthn/*` (per-origin callbacks
  and passkey `rpID`), `/connect/oauth`, `/health*`, `/__maintenance/*`,
  webhooks, and package invocation APIs. Leave unset to dual-serve legacy hosts
  without redirecting browser navigation.

## Hosted package app origin

Wrangler `var` (public and non-secret; required in production, optional in
confirmed non-production runtimes; see `packages/worker/src/app-base-url.ts` and
`packages/worker/src/app/package-app-origin.ts`):

- `PACKAGE_APP_BASE_URL` — the **apex** origin of the package-app domain that
  hosted package apps are served from. Production sets `https://kody.run` in
  `packages/worker/wrangler.jsonc`, and the deploy publishes **zone routes** for
  the apex (`<apex-host>/*`) and the per-user wildcard (`*.<apex-host>/*`) on
  the runtime Worker — never a custom domain in this zone (replacing a zone's
  route table detaches its custom domains and deletes their DNS records). Zone
  routes do not create DNS records, so production CI ensures proxied placeholder
  records for both names separately (see
  [setup-manifest.md](./setup-manifest.md)). Each owner's apps are addressed at
  `https://{username}.<apex-host>/packages/{kodyId}/...`; the apex itself serves
  only redirects (legacy `/@user/packages/...` paths to the owning subdomain,
  `/` to the app origin). It **must be a separate registrable domain** from
  `APP_BASE_URL`: that is what makes author-supplied package code cross-site, so
  the `SameSite=Lax` `kody_session` cookie never reaches it. Production origin
  validation also requires `APP_BASE_URL` so this relationship can be checked at
  runtime. Production returns `500` for package-app requests when this value is
  missing, invalid, equal to `APP_BASE_URL`, or on the same registrable domain;
  it never falls back to inline serving. Preview, tests, and E2E may leave it
  unset and keep serving package apps inline on the app origin at
  `/@{username}/packages/*`.

  `npm run dev` runs the **production** Wrangler environment, so the committed
  production value reaches local dev too; `getPackageAppBaseUrl` ignores an
  origin a local server cannot answer on, which keeps `npm run dev` inline. Set
  `PACKAGE_APP_BASE_URL=http://packages.localhost:<port>` in
  `packages/worker/.env` to exercise the two-origin flow locally. See
  [Hosted package app origin isolation](./security.md#hosted-package-app-origin-isolation).

- `PACKAGE_APP_LEGACY_HOSTS` — optional comma-separated previous package-app
  apex hostnames (production commits `kodyapps.dev`) that remain attached and
  dual-served alongside `PACKAGE_APP_BASE_URL`. Generated runtime zone routes
  replace the Worker's whole route set, so every dual-served package-app host
  must be listed here — otherwise the next deploy detaches omitted origins and
  deletes their DNS records. May also be set as a GitHub Actions repository
  variable (non-empty overlay wins).
- `PACKAGE_APP_LEGACY_REDIRECT` — exact string `true` enables path-and-query-
  preserving `308` redirects from legacy package-app **user subdomains**
  (`{username}.kodyapps.dev` → `{username}.kody.run`) for browser GET/HEAD only.
  Leave unset to dual-serve: package-app session cookies use the `__Host-`
  prefix, so they are host-only and cannot follow a redirect. Apex `/` on a
  legacy package-app host still redirects to the app origin (`kody.codes`); it
  is never sent to the canonical package-app apex. Dual-serve is the default;
  set this GitHub Actions repository variable to `true` only for the GET/HEAD
  redirect window.

## MCP `execute` and outbound HTTP

MCP `execute` runs sandboxed JavaScript with a global `fetch`. Calls to
third-party APIs can use stored secrets via `{{secret:name}}` placeholders in
URLs and headers where the MCP runtime supports them. Host allowlists and
capability policies apply per secret. There are no GitHub-specific Worker
environment variables.

## Social login (GitHub / Google / X)

Optional Worker secrets (see `packages/worker/src/app/oauth-providers.ts` and
[`social-login.md`](./social-login.md)):

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `X_CLIENT_ID` / `X_CLIENT_SECRET`

A provider's login button only renders when both of its values are set. A
`MOCK_`-prefixed client id activates the in-worker mock provider flow on
non-production runtimes (used by local dev and E2E tests). In GitHub Actions the
values live under `OAUTH_`-prefixed secret names because Actions reserves
`GITHUB_*`; the deploy workflow maps them to the unprefixed Worker secrets.

## Kit waiting list

Optional Worker secrets / vars for the public `/signup` waiting-list form
(`POST /waiting-list`):

- `KIT_API_KEY` — Kit v4 API key (`X-Kit-Api-Key`). Required for production
  waiting-list joins to succeed; when unset, production returns 503 for the
  endpoint while the rest of the app stays up. Preview deploys omit the key so
  joins no-op instead of writing to the production Kit audience.
- `KIT_WAITLIST_TAG_ID` — optional override for the Kit tag id (defaults to the
  `waitlist::kody` tag).
- `KIT_WAITLIST_SEQUENCE_ID` — optional override for the welcome sequence id
  (defaults to "Kody Waitlist Welcome", from `hello@kentcdodds.com`).
- `KIT_SIGNED_UP_TAG_ID` — optional override for the Kit tag applied on account
  signup when the email already exists in Kit (defaults to `signed_up::kody`).
  Signup never creates Kit subscribers and never fails when Kit is unset.

See [`architecture/authentication.md`](./architecture/authentication.md).

## Stripe billing

Optional Worker secret and vars for account subscription billing
(`packages/worker/src/billing/`, routes under `/account/billing`). When
`STRIPE_SECRET_KEY` is unset, billing is disabled: the account billing page
shows plan info plus a "not configured" notice, and success/portal/cron skip
safely. Manual `users.plan` grants and invite-assigned plans apply regardless.

- `STRIPE_SECRET_KEY` — Stripe secret API key. Required for checkout linking,
  portal sessions, and `stripe_plan` refresh. Synced as a Worker secret from the
  GitHub Actions secret of the same name on production deploy when set.
- `STRIPE_WEBHOOK_SECRET` — Stripe endpoint signing secret (`whsec_...`) for
  `POST /webhooks/stripe`. When unset, the webhook endpoint returns 503. Synced
  as a Worker secret from the GitHub Actions secret of the same name on
  production deploy when set.
- `STRIPE_API_BASE_URL` — optional API base URL; defaults to
  `https://api.stripe.com` when unset. Override for tests/mocks.
- `STRIPE_STANDARD_PRICE_ID` — Stripe Price id for the $12/month `standard`
  plan.
- `STRIPE_STANDARD_YEARLY_PRICE_ID` — Stripe Price id for the
  $120/year
  `standard` plan ($10/month billed annually).
- `STRIPE_PRO_PRICE_ID` — Stripe Price id for the $29/month `pro` plan.
- `STRIPE_PRO_YEARLY_PRICE_ID` — Stripe Price id for the
  $288/year `pro` plan
  ($24/month billed annually).

Each price id independently enables authenticated Checkout and subscription
matching for its tier and interval; leaving a monthly or yearly id unset makes
only that interval unavailable for purchase. Price ids are public (non-secret)
values committed as production Wrangler vars in
`packages/worker/wrangler.jsonc`, not Worker secrets. Retired $5/$20 monthly
prices remain in Stripe and are still matched so existing subscribers keep their
plan.

See [`architecture/entitlements.md`](./architecture/entitlements.md) (Billing).

## Saved-secret encryption (`SECRET_STORE_KEY`)

Required Worker secret used to derive the AES-GCM key for encrypting saved
secrets at rest in D1.

- **Every environment must set `SECRET_STORE_KEY`**, including local dev and CI,
  so saved secrets can be encrypted and decrypted.
- See [`docs/contributing/secret-rotation.md`](./secret-rotation.md) for
  rotation procedures.

## MCP capability search (Vectorize + Workers AI)

Worker bindings (see `packages/worker/wrangler.jsonc`):

- **`CAPABILITY_VECTOR_INDEX`** — Cloudflare Vectorize index for semantic
  retrieval (`kody-capabilities-prod` / `kody-capabilities-preview`). Create
  indexes with **`--dimensions=384 --metric=cosine`** to match
  `@cf/baai/bge-small-en-v1.5` with `cls` pooling (see
  `packages/worker/src/vectorize/embedding.ts`). The **`test`** Wrangler
  environment omits this binding so `npm run test` and e2e use the deterministic
  offline fusion path (`offline: true` in search results).
- **`AI`** — Workers AI binding used by production and preview capability,
  memory, job, and saved-package embedding calls. Local dev and tests do not
  require it because `WRANGLER_IS_LOCAL_DEV`, `SENTRY_ENVIRONMENT=test`, or a
  missing non-production binding keeps search on the deterministic offline path.

Worker secrets:

- **`AI_GATEWAY_ID`** — Cloudflare AI Gateway id. When set, embedding calls use
  the Workers AI binding `gateway` option so production and preview inference is
  logged/routed through AI Gateway. When unset, the Worker calls Workers AI
  directly.
- **`CAPABILITY_REINDEX_SECRET`** — strongly recommended for production (CI
  skips the post-deploy capability reindex and execute smoke check when it is
  unset); bearer token for `POST /__maintenance/reindex-capabilities` and other
  secret-gated maintenance endpoints. Use the reindex endpoint after changing
  the embedding model, pooling, or Vectorize index dimensions; it rebuilds
  built-in capability, memory, job, and saved-package vectors with per-user
  `userId` metadata on user-owned rows. Local dev uses offline search while
  `WRANGLER_IS_LOCAL_DEV` is set or the binding is missing.

## Cloudflare API (Worker + Email)

Optional Worker secrets/vars (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/mcp/cloudflare/cloudflare-rest-client.ts`):

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token used by the internal API client
  (`Authorization: Bearer ...`) for Worker-side Cloudflare REST calls such as
  the Cloudflare Email sender. User Cloudflare API calls from authored package
  modules use saved secrets and secret-aware `fetch` (see
  `docs/contributing/packages-and-manifests.md`). Local `npm run dev` sets this
  to the Cloudflare mock token unless `SKIP_CLOUDFLARE_MOCK=1`.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id required by the Cloudflare
  Email Service REST API fallback used by local mocks and preview deploys. This
  is a Worker var (not a secret) and should match the account behind
  `CLOUDFLARE_API_TOKEN`.
- `CLOUDFLARE_API_BASE_URL` — API base URL; defaults to
  `https://api.cloudflare.com` when unset, including for outbound email sending.
  Local `npm run dev` sets this to the Cloudflare mock Worker unless
  `SKIP_CLOUDFLARE_MOCK=1`. That same local mock serves the Artifacts REST
  control-plane endpoints used by `packages/worker/src/repo/artifacts.ts`
  (`repos`, `tokens`, and `fork`), so local repo create/get/list/token/fork
  calls do not need the live Artifacts REST API.
- `USER_EMAIL_DOMAIN` — optional override for the user email domain (see
  `packages/worker/src/email/platform-address.ts`). Defaults to
  `inbox.<APP_BASE_URL hostname>` (for example `inbox.kody.codes`): every user
  inbox and user outbound sender lives at `{username}@<this domain>`. User mail
  deliberately lives on a subdomain so the user-controlled namespace and its
  sender reputation stay separate from system transactional mail
  (`kody@<apex>`). The deployment's Cloudflare zone needs Email Routing enabled
  for this subdomain (Email > Email Routing > Settings > Add subdomain) with its
  catch-all routed to the Worker. Production commits
  `USER_EMAIL_DOMAIN=inbox.kody.codes` in `packages/worker/wrangler.jsonc` so
  the domain can never silently rederive from `APP_BASE_URL`; the deploy tooling
  (`tools/ci/production-resources.ts`) reads the same committed pin when
  configuring the Email Sending event subscription.
- `SYSTEM_EMAIL_DOMAIN` — optional override for the system email domain (the
  `kody@<domain>` transactional sender and operator system inboxes). Defaults to
  the `APP_BASE_URL` hostname. Production commits
  `SYSTEM_EMAIL_DOMAIN=kody.codes`.
- `LEGACY_USER_EMAIL_DOMAINS` / `LEGACY_SYSTEM_EMAIL_DOMAINS` — optional
  comma-separated additional email domains that inbound mail is accepted on
  alongside the canonical domains (see
  `packages/worker/src/email/platform-address.ts`). Delivery resolves to the
  same inboxes; outbound always sends from the canonical domains. Production
  commits `inbox.heykody.app,inbox.heykody.dev` / `heykody.app,heykody.dev`.
  Empty the lists when retiring the old domains' email DNS.
- `ARTIFACTS_NAMESPACE` — Cloudflare Artifacts namespace for repo REST calls.
  Defaults to `default` when unset (local dev and tests). Wrangler sets
  `production` and `preview` per environment in
  `packages/worker/wrangler.jsonc`. New repo sessions persist this value in D1
  as `session_repo_namespace` so follow-up lookups resolve the correct namespace
  even after env changes.

## Disaster recovery (production Worker)

Optional production-only vars/secrets for the nightly non-D1 staging exporter
and chunked restore endpoint (`packages/worker/src/dr/`). All are inert until
`DR_EXPORT_ENABLED` is the literal string `"true"` and S3 credentials are set.
See [Disaster recovery](./disaster-recovery.md).

- `DR_EXPORT_ENABLED` — Worker var; enable staging only when `"true"`.
- `DR_BACKUP_ACCOUNT_ID` / `DR_BACKUP_BUCKET_NAME` — DR account id and backup
  bucket name (S3 API endpoint host uses the account id).
- `DR_BACKUP_ACCESS_KEY_ID` / `DR_BACKUP_SECRET_ACCESS_KEY` — Worker secrets; R2
  S3 credentials that can write `staging/` and `blobs/` in the DR bucket.
- `BACKUP_MANIFEST_SIGNING_KEY_ID` /
  `BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64` — public verification
  material shared with the DR control plane. The Mailbox importer fails closed
  when either differs from the signed full manifest.
- `DR_RESTORE_SECRET` — Worker secret; bearer token for
  `POST /__maintenance/dr-restore`, `POST /__maintenance/dr-mailbox-import`, and
  the operator-only `POST /__maintenance/do-pitr`. Must match the control-plane
  secret of the same name. Fail-closed when unset.

## Backup control plane (DR account Worker)

Lives under `packages/backup-control-plane/` in the DR Cloudflare account. Code
deploys via the production GitHub Actions workflow when control-plane / shared
backup contract or backup-resource paths change. GitHub Actions requires
`DR_DEPLOY_TOKEN` and `DR_BACKUP_ACCOUNT_ID`. An optional
`DR_BACKUP_ADMIN_TOKEN` with DR-account Workers R2 Storage Write reconciles and
reads back the lock/lifecycle policy before the Worker deploy. When unavailable,
Actions logs a reconciliation skip and deploys normally. The admin token is
never installed as a Worker secret. Enable gates and source identity vars live
in that package's `wrangler.jsonc`.

Workflow bindings are `BACKUP_WORKFLOW` and `RESTORE_WORKFLOW`.

Non-secret vars:

- `ENABLE_PRODUCTION_D1_BACKUPS` / `BACKUP_BENCHMARK_APPROVED` — both must be
  exactly `"true"` or schedules stay inert.
- `SOURCE_ACCOUNT_ID` / `SOURCE_DATABASE_ID` / `SOURCE_DATABASE_NAME` plus
  `ALLOWED_SOURCE_ACCOUNT_IDS` / `ALLOWED_SOURCE_DATABASE_IDS`.
- `BACKUP_MANIFEST_SIGNING_KEY_ID`,
  `BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64`,
  `TRUSTED_RESTORE_BASELINE_ID`, `TRUSTED_RESTORE_BASELINE_SHA256`.
- `BACKUP_MAX_AGE_HOURS` (default 26), `BACKUP_MAX_SOURCE_BYTES` (≤ 4.5e9).
- `ACCESS_TEAM_DOMAIN`, `ACCESS_APP_AUD`, `ACCESS_ALLOWED_EMAIL` — Zero Trust
  Access JWT verification (policy pinned to the solo operator email).
- `DRILL_ACCOUNT_ID` — isolated account for UI restore drills (must differ from
  source).
- `PRIMARY_WORKER_ORIGIN` — production Worker origin for
  `/__maintenance/dr-restore`.

Secrets (Wrangler secret storage only — never `.env`, config, logs, or
evidence):

- `CLOUDFLARE_API_TOKEN` — production-account Account D1 Edit (export +
  production import).
- `BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64` — base64 Ed25519 PKCS#8.
- `DRILL_API_TOKEN` — drill-account D1 Edit for isolated UI drills.
- `RESTORE_CONFIRM_SECRET` — HMAC secret for the 10-minute prepare→execute
  production-restore token.
- `DR_RESTORE_SECRET` — bearer shared with the production Worker.

GitHub Actions `workflow_dispatch` escrow (`.github/workflows/dr-escrow.yml`)
also needs `SECRET_STORE_KEY`, `SECRET_ESCROW_PASSPHRASE`, and the DR S3
credentials (`DR_BACKUP_*`) as repository secrets.

## Why a schema?

The `remix/data-schema` env schema gives type inference for `Env`-driven values
and a single runtime gate that fails fast with clear errors. It keeps the
“what’s required” definition in one place.
