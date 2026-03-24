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
4. In `cli.ts`, start the mock Worker during `bun run dev` (via `wrangler dev`)
   and set `ACME_API_BASE_URL` to the mock Worker origin.

See `packages/mock-servers/github/` for the GitHub REST + GraphQL subset mock
package used by the `github_rest` and `github_graphql` capabilities (started by
`bun run dev` unless `SKIP_GITHUB_MOCK=1`).

See `packages/mock-servers/cursor/` for a small
[Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)
subset mock used by the `cursor_cloud_rest` capability (started by `bun run dev`
unless `SKIP_CURSOR_MOCK=1`).

See `packages/mock-servers/cloudflare/` for a small Cloudflare API v4 subset
mock used by the `cloudflare_rest` capability (started by `bun run dev` unless
`SKIP_CLOUDFLARE_MOCK=1`).

### Tips

- Avoid persisting mock requests/messages in D1; keep mock state in a Durable
  Object to reduce schema drift while still providing per-mock durability.
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
