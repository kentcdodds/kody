# Environment variables

Use this guide when you add a new environment variable to the starter. It keeps
types, runtime validation, and documentation in sync.

## Steps

1. **Add the type**
   - Update `types/env.d.ts` so `Env` includes the new variable.

2. **Validate at runtime**
   - Add the variable to the Zod schema in `types/env-schema.ts`.
   - `server/env.ts` uses the schema to fail fast at runtime.
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
   	THIRD_PARTY_API_KEY: z
   		.string()
   		.min(
   			1,
   			'Missing THIRD_PARTY_API_KEY. Go to https://example.com/ to get one.',
   		),
   })
   ```

3. **Add local defaults**
   - Update `.env.example` (source for new local `.env` files).

4. **Update required resources docs**
   - Add the variable to `docs/setup-manifest.md`.

5. **Sync deploy secrets**
   - Add the variable to the relevant GitHub Actions workflows so it is pushed
     via `wrangler secret put`:
     - `.github/workflows/deploy.yml` (production deploys)
     - `.github/workflows/preview.yml` (preview deploys)

## Sentry

Optional Worker secret and vars (see `types/env-schema.ts` and
`sentry/cloudflare-options.ts`):

- `SENTRY_DSN` — ingest URL from your Sentry project. When unset, the Worker
  skips `Sentry.withSentry`; Durable Objects use the same options builder and
  will not send events without a DSN.
- `SENTRY_ENVIRONMENT` — also set as a Wrangler `var` per environment in
  `wrangler.jsonc` for deploys.
- `SENTRY_TRACES_SAMPLE_RATE` — optional `0`–`1`; defaults to **`1.0`** (sample
  all traces). Set lower (e.g. `0.1`) for higher traffic or Sentry quota.

## GitHub (`github_rest` capability)

Optional Worker secrets/vars (see `types/env-schema.ts` and
`mcp/github/github-rest-client.ts`):

- `GITHUB_TOKEN` — Bearer token for `api.github.com` (fine-grained PAT
  recommended) for the `kody-bot` account. GitHub REST calls act as that bot
  identity rather than as `kentcdodds`. When unset, `github_rest` fails fast
  with a setup hint. In GitHub Actions you cannot create a repository secret
  named `GITHUB_*`; production deploy reads **`KODY_GITHUB_TOKEN`** and syncs it
  to this Worker secret (see `docs/setup-manifest.md`).
- `GITHUB_API_BASE_URL` — REST API base URL; defaults to
  `https://api.github.com` when unset. Local `bun run dev` sets this to the
  GitHub mock Worker unless `SKIP_GITHUB_MOCK=1`.

## MCP capability search (Vectorize + Workers AI)

Worker bindings (see `wrangler.jsonc`):

- **`CAPABILITY_VECTOR_INDEX`** — Cloudflare Vectorize index for semantic
  retrieval (`kody-capabilities-prod` / `kody-capabilities-preview`). Create
  indexes with **`--dimensions=384 --metric=cosine`** to match
  `@cf/baai/bge-small-en-v1.5` (see `mcp/capabilities/capability-search.ts`).
  The **`test`** Wrangler environment omits this binding so `bun test` and e2e
  use the deterministic offline fusion path (`offline: true` in search results).

Optional Worker secret:

- **`CAPABILITY_REINDEX_SECRET`** — Bearer token for
  `POST /__maintenance/reindex-capabilities` (production deploy workflow calls
  this after healthcheck when the GitHub secret is set). Local dev uses offline
  search while `WRANGLER_IS_LOCAL_DEV` is set or the binding is missing.

## Cursor Cloud Agents (`cursor_cloud_rest` capability)

Optional Worker secrets/vars (see `types/env-schema.ts` and
`mcp/cursor/cursor-cloud-client.ts`):

- `CURSOR_API_KEY` — Cursor API key ([dashboard](https://cursor.com/settings)).
  The Cursor Cloud API uses **HTTP Basic** auth (key as username, empty
  password). When unset, `cursor_cloud_rest` fails fast with a setup hint.
- `CURSOR_API_BASE_URL` — API base URL; defaults to `https://api.cursor.com`
  when unset. Local `bun run dev` sets this to the Cursor mock Worker unless
  `SKIP_CURSOR_MOCK=1`. See `docs/agents/mock-api-servers.md`.

## Why Zod?

Zod gives type inference for `Env`-driven values and a single runtime gate that
fails fast with clear errors. It keeps the “what’s required” definition in one
place.
