# 0040: Same-repo writers may PUT the Nx cache; fork PRs may not

- **Status:** accepted
- **Date:** 2026-08-27

## Context

[0038](./0038-no-nx-cloud-read-write-cache-tokens.md) split read and write
tokens so untrusted CI could not poison hashes `main` later GETs.
[0039](./0039-no-same-repo-pr-cache-writes.md) treated every `pull_request` job
as untrusted, including same-repo branches, because the workflow file and
checkout come from the PR. That over-counted the threat. The people who can push
to this repository already have the write token on Cloud Agent environments and
locally. Giving the same token to their `pull_request` jobs does not create a
new writer.

Fork PRs are the other class: they cannot push to origin and must not receive
the write token.

## Decision

Anyone who can push may write the remote cache before review. Validate presents
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (worker `CACHE_ACCESS_TOKEN`) on
`push`, `workflow_dispatch`, and non-fork `pull_request`. Fork `pull_request`
jobs present `NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN` (worker
`CACHE_READ_TOKEN`) only — if that secret is unset, remote cache stays off. Do
not use `pull_request_target` to hand the write token to a fork. Agents keep the
write token. Supersedes 0039.

## Consequences

Same-repo PR CI can populate hashes `main` later GETs. A fork still cannot PUT.
The remaining hole is a compromised or prompt-injected session of someone who
already has write access — the same session that can PUT from a laptop. Revisit
if write access is granted to actors who must not hold the local write token.
