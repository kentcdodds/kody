## Mock API servers

Mock servers emulate third-party APIs during local development and PR previews.
Each mock lives in `mock-servers/<service>/` as a dedicated Cloudflare Worker so
it can also be deployed alongside the main app.

### Add a new third-party mock

1. Create a new directory under `mock-servers/`, for example
   `mock-servers/acme/`.
2. Add a Worker entrypoint (for example `mock-servers/acme/worker.ts`) that
   mirrors the third-party API (for example, `POST /resource`).
3. Add `mock-servers/acme/wrangler.jsonc` with the Worker config and any
   bindings (D1/KV/etc).
4. In `cli.ts`, start the mock Worker during `bun run dev` (via `wrangler dev`)
   and set `ACME_API_BASE_URL` to the mock Worker origin.

### Tips

- Prefer D1 for storing mock requests/messages so the mock can run both locally
  and in PR preview deploys.
- Add a `GET /__mocks` dashboard route so it is easy to discover endpoints and
  validate state while debugging.
- PR previews deploy each mock Worker with the name pattern
  `<app>-pr-<number>-mock-<service>` and configure the app preview to point at
  the deployed mock URL. A single generated token is shared between the app and
  all mock Workers for request authentication. The preview workflow includes an
  authenticated dashboard link in the PR comment (href includes `?token=...`) so
  you can open `/<service>/__mocks` without manually copying secrets.
- Set `"preview_urls": true` in each mock Worker `wrangler.jsonc` so Cloudflare
  emits version preview URLs in CI summaries when available.
