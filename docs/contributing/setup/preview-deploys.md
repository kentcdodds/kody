# PR preview deployments

The GitHub Actions preview workflow creates per-preview Cloudflare resources so
each PR preview is isolated. See the [setup index](./index.md) for the other
setup pages.

- App worker: `<preview-worker-name>` (for kody: `kody-pr-<n>`)
- Platform worker: `<preview-worker-name>-platform`
- Runtime worker: `<preview-worker-name>-runtime`
- Jobs worker: `<preview-worker-name>-jobs`
- Highlight worker: `<preview-worker-name>-highlight`
- App D1 database: `<preview-worker-name>-db`
- Audit D1 database: `<preview-worker-name>-audit-db`
- Jobs D1 database: ensured by `jobs-worker-resources.ts` for
  `<preview-worker-name>-jobs`
- KV namespace (OAuth state): `<preview-worker-name>-oauth-kv`
- Mock workers: `<preview-worker-name>-mock-<service>`

When a PR is closed, the cleanup job deletes the preview
app/platform/runtime/jobs Workers, mock Workers, and these resources as well.

Cloudflare Workers supports version `preview_urls`, but those preview URLs are
not available for Workers that use Durable Objects. The main app Worker binds
`MCP_OBJECT`, so app previews use per-PR Worker names. Mock Workers do not use
Durable Objects, so their Wrangler configs opt into `preview_urls = true` and
the workflow includes mock version preview links when Cloudflare returns them.

Production deploys also ensure required Cloudflare resources exist before
migrations/deploy:

- D1 database: from `env.production.d1_databases` binding `APP_DB`
- KV namespace: `OAUTH_KV` (defaults to `<worker-name>-oauth` when creating)

Both the preview and production deploy workflows run post-deploy healthchecks
and fail the job if any expected worker is missing the deployed commit:

- origin: `<deploy-url>/health` → `{ ok: true, commitSha }`
- platform: `/__platform/health` → `{ status: "ok", commitSha }`
- runtime: `/__runtime/health` → `{ status: "ok", commitSha }`
- jobs: `/health` on the jobs workers.dev URL → `{ ok: true, commit }` (jobs has
  no public hostname; the workflow uses the deploy output URL)

Preview deploys also run `node tools/seed-test-data.ts --remote` after deploy,
seeding `me@kentcdodds.com` / `ilikecode` (a non-admin account; the `jane`
companion account is only seeded locally). See `.github/workflows/preview.yml`
for the exact invocation.

Preview cleanup also deletes the matching GitHub environment
(`preview-<pr-number>`). That API requires repository administration write
access, so the repo must define a `PREVIEW_ENVIRONMENT_ADMIN_TOKEN` Actions
secret with a token that has that permission. Cleanup intentionally fails when
that secret is missing or under-scoped so permission regressions are visible.

The production deploy workflow can also be started manually from GitHub Actions
via **Run workflow** on `main`. The manual path verifies that the selected
commit is the current `origin/main` HEAD before it deploys.

If you ever need to do the same operations manually, use:

- `node tools/ci/preview-resources.ts ensure --worker-name <name> --out-config <path>`
- `node tools/ci/preview-resources.ts cleanup --worker-name <name>`
- `node tools/ci/production-resources.ts ensure --out-config <path>`

To **manually test** a PR preview (find the URL, sign in as the seeded user,
create specific data with `--request`, assert the change), see
[Manual preview testing](../preview-manual-testing.md) and run
`npm run preview:manual-test`.
