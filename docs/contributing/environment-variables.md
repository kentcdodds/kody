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

   Example:

   ```ts
   const EnvSchema = z.object({
   	COOKIE_SECRET: z
   		.string()
   		.min(
   			32,
   			'COOKIE_SECRET must be at least 32 characters for session signing.',
   		),
   	SECRET_STORE_KEY: z.string().min(32),
   	THIRD_PARTY_API_KEY: z
   		.string()
   		.min(
   			1,
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
  will not send events without a DSN.
- `SENTRY_ENVIRONMENT` — also set as a Wrangler `var` per environment in
  `packages/worker/wrangler.jsonc` for deploys.
- `SENTRY_TRACES_SAMPLE_RATE` — optional `0`–`1`; defaults to **`1.0`** (sample
  all traces). Set lower (e.g. `0.1`) for higher traffic or Sentry quota.

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
safely. Manual `users.plan` grants and invite-assigned plans still work.

- `STRIPE_SECRET_KEY` — Stripe secret API key. Required for checkout linking,
  portal sessions, and `stripe_plan` refresh. Synced as a Worker secret from the
  GitHub Actions secret of the same name on production deploy when set.
- `STRIPE_API_BASE_URL` — optional API base URL; defaults to
  `https://api.stripe.com` when unset. Override for tests/mocks.
- `STRIPE_PRO_PRICE_ID` — Stripe Price id used to map active/trialing
  subscriptions to the `pro` plan.
- `STRIPE_PRO_PAYMENT_LINK` — Stripe Payment Link URL for checkout. Production
  values are committed as Wrangler `vars` in `packages/worker/wrangler.jsonc`.

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
  `packages/worker/src/mcp/capabilities/capability-search.ts`). The **`test`**
  Wrangler environment omits this binding so `npm run test` and e2e use the
  deterministic offline fusion path (`offline: true` in search results).
- **`AI`** — Workers AI binding used by production and preview capability,
  memory, job, and saved-package embedding calls. Local dev and tests do not
  require it because `WRANGLER_IS_LOCAL_DEV`, `SENTRY_ENVIRONMENT=test`, or a
  missing non-production binding keeps search on the deterministic offline path.

Optional Worker secret:

- **`AI_GATEWAY_ID`** — Cloudflare AI Gateway id. When set, embedding calls use
  the Workers AI binding `gateway` option so production and preview inference is
  logged/routed through AI Gateway. When unset, the Worker calls Workers AI
  directly.
- **`CAPABILITY_REINDEX_SECRET`** — Bearer token for
  `POST /__maintenance/reindex-capabilities` (production deploy workflow calls
  it after healthcheck when the GitHub secret is set). Use this endpoint after
  changing the embedding model, pooling, or Vectorize index dimensions; it
  rebuilds built-in capability, memory, job, and saved-package vectors with
  per-user `userId` metadata on user-owned rows. Local dev uses offline search
  while `WRANGLER_IS_LOCAL_DEV` is set or the binding is missing.

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
  `inbox.<APP_BASE_URL hostname>` (for example `inbox.heykody.dev`): every user
  inbox and user outbound sender lives at `{username}@<this domain>`. User mail
  deliberately lives on a subdomain so the user-controlled namespace and its
  sender reputation stay separate from system transactional mail
  (`kody@<apex>`). The deployment's Cloudflare zone needs Email Routing enabled
  for this subdomain (Email > Email Routing > Settings > Add subdomain) with its
  catch-all routed to the Worker.
- `ARTIFACTS_NAMESPACE` — Cloudflare Artifacts namespace for repo REST calls.
  Defaults to `default` when unset (local dev and tests). Wrangler sets
  `production` and `preview` per environment in
  `packages/worker/wrangler.jsonc`. New repo sessions persist this value in D1
  as `session_repo_namespace` so follow-up lookups resolve the correct namespace
  even after env changes.

## Why Zod?

Zod gives type inference for `Env`-driven values and a single runtime gate that
fails fast with clear errors. It keeps the “what’s required” definition in one
place.
