# kody Nx remote cache

Self-hosted Nx HTTP remote cache for this repository. Agents and GitHub Actions
share task artifacts so CI does not rerun work the agent already completed.

The worker implements the
[Nx self-hosted cache OpenAPI spec](https://nx.dev/docs/kb/self-hosted-caching):
`GET`/`PUT /v1/cache/{hash}` with bearer auth, `409` on overwrite, and artifacts
stored in R2. `neverConnectToCloud` stays on so Nx does not prompt for Nx Cloud.

Public URL: `https://nx-cache.kody.codes`.

## Clients

Set both variables in GitHub Actions (validate jobs) and in Cursor Cloud Agent
environments:

```bash
NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://nx-cache.kody.codes
NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=<same value as the Worker secret>
```

Leave them unset to run with the local `.nx` cache only. Validate and
`test:push` use `CI=1` so cache hashes match GitHub Actions (`CI=true` would
miss).

## Deploy

Production deploy creates the `kody-nx-cache` R2 bucket, uploads the worker, and
syncs `CACHE_ACCESS_TOKEN` from the `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`
GitHub Actions secret. The job no-ops when that secret is missing so a first
merge does not block production.
