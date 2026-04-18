## Mock API servers

Mock servers emulate third-party APIs during local development and PR previews.
Each mock lives in `packages/mock-servers/<service>/` as a dedicated Cloudflare
Worker package so it can also be deployed alongside the main app.

### Add a new third-party mock

1. Create a new directory under `packages/mock-servers/`, for example
   `packages/mock-servers/acme/`.
2. Add a Worker entrypoint (for example
   `packages/mock-servers/acme/src/worker.ts`) that mirrors the third-party API
   (for example, `POST /resource`).
3. Add `packages/mock-servers/acme/wrangler.jsonc` with the Worker config and
   any bindings (D1/KV/etc).
4. In `cli.ts`, start the mock Worker during `npm run dev` (via `wrangler dev`)
   and set `ACME_API_BASE_URL` to the mock Worker origin.

See `packages/mock-servers/cloudflare/` for a small Cloudflare API v4 subset
mock used by tests and the internal API client (started by `npm run dev`
unless `SKIP_CLOUDFLARE_MOCK=1`). It now covers the Cloudflare Email REST
fallback plus the Artifacts REST control-plane endpoints used by
`packages/worker/src/repo/artifacts.ts` (`repos`, `repo info`, `tokens`, and
`fork`).

### Tips

- Avoid persisting mock requests/messages in D1; keep mock state in a Durable
  Object to reduce schema drift while still providing per-mock durability. If a
  mock uses module-scope in-memory state instead, treat it as best-effort only:
  it survives warm requests in a single isolate, is lost on cold starts, and is
  not shared across isolates, so `/__mocks` views can differ between previews.
- Add a `GET /__mocks` dashboard route so it is easy to discover endpoints and
  validate state while debugging.
- PR previews deploy each mock Worker with the name pattern
  `<app>-pr-<number>-mock-<service>` and configure the app preview to point at
  the deployed mock URL. A single generated token is shared between the app and
  all mock Workers for request authentication. The preview workflow includes an
  authenticated dashboard link in the PR comment (href includes `?token=...`) so
  you can open `/<service>/__mocks` without manually copying secrets.
- Set `"preview_urls": true` in each
  `packages/mock-servers/<service>/wrangler.jsonc` so Cloudflare emits version
  preview URLs in CI summaries when available.
