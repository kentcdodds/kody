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
