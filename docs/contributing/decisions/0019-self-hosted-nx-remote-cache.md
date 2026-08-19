# 0019: Self-hosted Nx remote cache (not Nx Cloud)

- **Status:** accepted
- **Date:** 2026-08-16

## Context

Agents already run the same Nx targets CI runs (`test:node`, `test:workers`,
`test:e2e`, `test:mcp`, `typecheck`). Nx was only writing a local `.nx/cache`
(gitignored, `neverConnectToCloud: true`), so GitHub Actions always started
cold. Official S3/GCS/Azure cache packages are deprecated (CVE-2025-36852). Nx
Cloud would share artifacts, but it is a third-party control plane this repo
does not want to prompt for or depend on.

## Decision

Keep `neverConnectToCloud: true`. Share cache through a small Cloudflare Worker
(`packages/nx-cache`, `nx-cache.kody.codes`) that implements the Nx HTTP OpenAPI
spec and stores artifacts in R2. Clients set
`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`. Validate jobs also restore `.nx` via
`actions/cache` as a same-runner L1. Test hashes include `{env:CI}` and CI pins
`CI=1` so agent `validate` / `test:push` and GitHub Actions share keys.

## Consequences

Remote hits require the access token in GitHub Actions and in Cursor Cloud Agent
environments; without it, tasks run locally as before. Validate jobs probe
`GET /health` and an authorized `GET /v1/cache/{hash}` before setting the server
URL because Nx treats an unreachable or unauthorized self-hosted cache as a
fatal error. First PUT wins (`409` on overwrite) so a poisoned key cannot
replace a stored artifact. R2 expires `v1/` objects 14 days after write (Age,
not last access — GET does not refresh mtime) and aborts incomplete multipart
uploads after 1 day. The cache worker is contributor infra, not a product
primitive, and holds no user data. Revisit only if Nx Cloud becomes mandatory
for a feature we need, or if the HTTP spec changes.
