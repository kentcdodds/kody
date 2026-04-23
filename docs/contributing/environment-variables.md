# Environment variables

Use this guide when you add a new environment variable to the starter. It keeps
types, runtime validation, and documentation in sync.

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

## MCP capability search (Vectorize + Workers AI)

Worker bindings (see `packages/worker/wrangler.jsonc`):

- **`CAPABILITY_VECTOR_INDEX`** — Cloudflare Vectorize index for semantic
  retrieval (`kody-capabilities-prod` / `kody-capabilities-preview`). Create
  indexes with **`--dimensions=384 --metric=cosine`** to match
  `@cf/baai/bge-small-en-v1.5` (see
  `packages/worker/src/mcp/capabilities/capability-search.ts`). The **`test`**
  Wrangler environment omits this binding so `npm run test` and e2e use the
  deterministic offline fusion path (`offline: true` in search results).

Optional Worker secret:

- **`CAPABILITY_REINDEX_SECRET`** — Bearer token for
  `POST /__maintenance/reindex-capabilities` and
  `POST /__maintenance/reindex-skills` (production deploy workflow calls both
  after healthcheck when the GitHub secret is set). Use skill reindex when
  `mcp_skills` and Vectorize disagree (restore, manual D1 edits, etc.). Local
  dev uses offline search while `WRANGLER_IS_LOCAL_DEV` is set or the binding is
  missing.

## Cloudflare API (Worker + Email)

Optional Worker secrets/vars (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/mcp/cloudflare/cloudflare-rest-client.ts`):

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token used by the internal API client
  (`Authorization: Bearer ...`) for Worker-side Cloudflare REST calls such as
  the Cloudflare Email sender. User Cloudflare API calls from authored package
  modules use saved secrets and secret-aware `fetch` (see
  `docs/contributing/packages-and-manifests.md`). Local `npm run dev` sets this
  to the Cloudflare mock token unless `AI_MODE=remote` or
  `SKIP_CLOUDFLARE_MOCK=1`.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id required by the Cloudflare
  Email Service REST API fallback used by local mocks and preview deploys. This
  is a Worker var (not a secret) and should match the account behind
  `CLOUDFLARE_API_TOKEN`.
- `CLOUDFLARE_API_BASE_URL` — API base URL; defaults to
  `https://api.cloudflare.com` when unset, including for outbound email sending.
  Local `npm run dev` sets this to the Cloudflare mock Worker unless
  `AI_MODE=remote` or `SKIP_CLOUDFLARE_MOCK=1`. That same local mock
  serves the Artifacts REST control-plane endpoints used by
  `packages/worker/src/repo/artifacts.ts` (`repos`, `tokens`, and `fork`), so
  local repo create/get/list/token/fork calls do not need the live Artifacts
  REST API.

## Home connector bridge

Optional Worker secret/var (see `packages/worker/src/env-schema.ts` and
`packages/worker/src/home/session.ts`):

- `packages/home-connector` participates in the npm workspace and executes
  directly on Node 24. Local and container runs therefore need a recent Node
  release with `node:sqlite` support.
- `HOME_CONNECTOR_SHARED_SECRET` — shared secret used by the locally running
  `packages/home-connector` service when it opens the outbound WebSocket session
  to the worker. When unset, the worker rejects home connector registration and
  the internal home MCP bridge cannot route `home` capabilities.

### Remote connector secrets (Worker)

See `packages/worker/src/env-schema.ts` and
`packages/worker/src/remote-connector/resolve-remote-connector-secret.ts`.

- `REMOTE_CONNECTOR_SECRETS` — optional Worker **secret** (JSON string) whose
  value is a JSON object mapping **`"kind:instanceId"`** keys (trimmed, kind
  lowercased) to **shared secret strings** for **`connector.hello`**. When a key
  is present, it overrides per-connector lookup before any kind-specific
  fallback. At Worker boot, invalid JSON or malformed keys fail env validation
  with a clear error. At runtime, if the value is a plain string in a test
  harness, malformed JSON is logged and ignored for map lookup only.
- For **`kind: home`**, if a key is missing in the map, the worker falls
  back to **`HOME_CONNECTOR_SHARED_SECRET`**. Non-`home` kinds have **no**
  legacy fallback; they must appear in the map (or hello is rejected).

Authoring guide for outbound WebSocket services:
[`architecture/remote-connectors.md`](./architecture/remote-connectors.md).

- `HOME_CONNECTOR_*` — when you start the full local stack with `npm run dev`,
  any `HOME_CONNECTOR_`-prefixed variable is forwarded to the child connector
  process with the prefix removed. For example, `HOME_CONNECTOR_MOCKS=false`
  sets `MOCKS=false` for `packages/home-connector`, and
  `HOME_CONNECTOR_ROKU_DISCOVERY_URL=...` sets `ROKU_DISCOVERY_URL=...`. This
  also applies to `HOME_CONNECTOR_LUTRON_DISCOVERY_URL=...`,
  `HOME_CONNECTOR_SENTRY_DSN`, `HOME_CONNECTOR_SENTRY_ENVIRONMENT`, and
  `HOME_CONNECTOR_SENTRY_TRACES_SAMPLE_RATE`.
- `ROKU_DISCOVERY_URL` — optional connector env var. Defaults to
  `ssdp://239.255.255.250:1900`. Mocked connector runs should set an explicit
  value such as `http://roku.mock.local/discovery`.
- `SENTRY_DSN` — optional connector env var. When set for
  `packages/home-connector`, the service initializes `@sentry/node` and reports
  startup errors, websocket failures, and handled operational exceptions. Use
  `HOME_CONNECTOR_SENTRY_DSN` when launching through `npm run dev`.
- `SENTRY_ENVIRONMENT` — optional connector env var. The published Docker image
  defaults this to `production`; otherwise the home connector falls back to
  `NODE_ENV` (or `development`) when unset.
- `SENTRY_TRACES_SAMPLE_RATE` — optional connector env var with a `0`–`1` value;
  the published Docker image defaults this to **`1.0`**, matching the Worker’s
  low-traffic default.
- `APP_COMMIT_SHA` — optional connector env var used as the Sentry release
  identifier. The published Docker image bakes this in at build time from the
  Git commit SHA and also exposes the same value via the image’s OCI revision
  label.
- `SAMSUNG_TV_DISCOVERY_URL` — optional connector env var. Defaults to
  `mdns://_samsungmsf._tcp.local`. Mocked connector runs should set an explicit
  value such as `http://samsung-tv.mock.local/discovery`. Live discovery uses a
  single pure-JS mDNS path that works across macOS and Linux/container
  environments.
- `LUTRON_DISCOVERY_URL` — optional connector env var. Defaults to
  `mdns://_lutron._tcp.local`. Mocked connector runs should set an explicit
  value such as `http://lutron.mock.local/discovery`. Live discovery uses a
  single pure-JS mDNS path that works across macOS and Linux/container
  environments.
- `VENSTAR_SCAN_CIDRS` — optional connector env var. Comma-separated CIDR list
  for Venstar subnet scanning. Each entry must be `a.b.c.0/24` (scan
  `.1`–`.254`) or `a.b.c.d/32` (single host). When unset, the connector derives
  private `/24` networks from local IPv4 interfaces and probes
  `http://{ip}/query/info` directly. Example:
  `VENSTAR_SCAN_CIDRS=192.168.1.0/24,10.0.0.50/32`. Broader private interface
  CIDRs like `/23` are automatically split into multiple `/24` scan blocks.
- `HOME_CONNECTOR_DATA_PATH` — optional connector env var. Directory used for
  connector-owned local data files. When `HOME_CONNECTOR_DB_PATH` is unset, the
  home connector stores its local SQLite database at
  `<HOME_CONNECTOR_DATA_PATH>/home-connector.sqlite`. Defaults to
  `~/.kody/home-connector`.
- `HOME_CONNECTOR_DB_PATH` — optional connector env var. Full path to the local
  SQLite file used by the home connector to persist device integration state
  such as Samsung TV metadata/tokens, Lutron processor credentials, Bond bridge
  state, Sonos players, and Venstar managed thermostats across restarts.
  Overrides the derived `HOME_CONNECTOR_DATA_PATH` location.

## Why Zod?

Zod gives type inference for `Env`-driven values and a single runtime gate that
fails fast with clear errors. It keeps the “what’s required” definition in one
place.
