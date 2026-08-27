# kody Nx remote cache

Self-hosted Nx HTTP remote cache for this repository. Agents and GitHub Actions
share task artifacts so CI does not rerun work the agent already completed.

The worker implements the
[Nx self-hosted cache OpenAPI spec](https://nx.dev/docs/kb/self-hosted-caching):
`GET`/`PUT /v1/cache/{hash}` with bearer auth, `409` on overwrite, `403` when a
read-only token PUTs, and artifacts stored in R2. `neverConnectToCloud` stays on
so Nx does not prompt for Nx Cloud. `pull_request` validate uses the read token.
Validate on `push` to `main` and Cloud Agent environments use the write token so
post-merge CI and agents populate the cache and PR branches cannot.

Public URL: `https://nx-cache.kody.codes`.

## Clients

Nx always reads `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`. The value is the
write token on trusted writers (Cloud Agent environments, validate `push` to
`main`) and the read token on `pull_request` validate
(`NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN`).

```bash
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://nx-cache.kody.codes
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="<write-or-read-token>"
```

Leave them unset to run with the local `.nx` cache only. Validate and
`test:push` use `CI=1` so cache hashes match GitHub Actions (`CI=true` would
miss). On Cloud Agent VMs, `npm run hooks:ensure` composes Husky through
Cursor's hook dispatcher so `git push` still runs `test:push` and can upload
those artifacts before CI starts. GitHub Actions only sets the server URL after
`GET /health` succeeds and an authorized `GET /v1/cache/{hash}` returns 200 or
404 — Nx fails the job if the host is configured but unreachable or
unauthorized, so validate can still pass before the worker exists or after a
token rotation that has not been synced yet.

`npm run nx-cache:smoke` (also part of `test:node`) starts a local HTTP cache,
runs `nx-cache:smoke-probe` twice with an isolated local cache wiped in between,
and asserts the second run is a `[remote cache]` hit that restores outputs
without re-running the command.

## Retention

R2 expires `v1/` objects 14 days after they are written and aborts incomplete
multipart uploads after 1 day. Production deploy reapplies that lifecycle when
it ensures the bucket. First PUT wins (`409` on overwrite), so expiry is also
the window after which a poisoned hash can be replaced.

## Deploy

Production deploy (`.github/workflows/deploy.yml`) creates the `kody-nx-cache`
R2 bucket, applies the 14-day lifecycle, uploads the worker, and syncs
`CACHE_ACCESS_TOKEN` / `CACHE_READ_TOKEN` from the matching GitHub Actions
secrets when cache-related paths change or when that workflow is dispatched on
`main`. The job no-ops when the write secret is missing so a first merge does
not block production.

To redeploy only the cache worker (for example after rotating either token), run
**Actions → 🧊 Nx cache worker → Run workflow** on `main`
(`.github/workflows/nx-cache-deploy.yml`). That reuses the same job and does not
cancel an in-progress production deploy.
