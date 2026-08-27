# 0038: Still no Nx Cloud; split self-hosted cache read and write tokens

- **Status:** accepted
- **Date:** 2026-08-27

## Context

[0019](./0019-self-hosted-nx-remote-cache.md) keeps `neverConnectToCloud` and
shares Nx artifacts through `kody-nx-cache`. A later Nx-team review of that
worker asked to replace it with Nx Cloud (OSS plan, `nx affected`, Playwright
Atomizer, `start-ci-run --distribute-on`) because one read-write bearer was
shared by GitHub Actions and agent VMs. Same-repo `pull_request` jobs receive
repository secrets, so an untrusted branch could PUT an artifact that `main`
later GETs (the CREEP-shaped hole 0019 cited when declining the deprecated S3
plugins). First PUT still wins; it does not decide who may write first.

## Decision

Keep the self-hosted worker. Do not adopt Nx Cloud, `nx affected` as a validate
rewrite, Playwright Atomizer, or distributed Nx agents. Trusted writers (Cursor
Cloud Agent environments, and any host that should populate the cache) use
`CACHE_ACCESS_TOKEN`. GitHub Actions validate uses
`NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN` (`CACHE_READ_TOKEN` on the worker). PUT
with the read token returns `403` (`text/plain`); the Nx HTTP spec treats that
as a silent write skip.

## Consequences

PR CI can hit artifacts agents already wrote and cannot poison hashes for
`main`. A miss still runs locally. The worker, secret sync, and health/auth
probes stay contributor infra. Revisit Nx Cloud only if a required Nx feature
cannot work without their control plane (same gate as 0019).
