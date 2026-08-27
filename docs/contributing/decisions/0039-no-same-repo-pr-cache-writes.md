# 0039: Same-repo pull_request jobs do not write the Nx cache

- **Status:** accepted
- **Date:** 2026-08-27

## Context

[0038](./0038-no-nx-cloud-read-write-cache-tokens.md) split read and write
tokens so Actions could not poison hashes that `main` later GETs. After that
landed, validate on `push` to `main` was also read-only, so a change that never
went through a Cloud Agent never populated the remote cache. A follow-up asked
to restore writes from "trusted" same-repo PRs (owner/collaborator branches).

For `pull_request` on this repository, secrets are available **and** the
workflow file plus checkout come from the PR. A branch that only looks like a
docs tweak can still change `.github/actions/setup-validate` and PUT an artifact
for a hash of **unchanged** task inputs. First PUT wins. Author association does
not change which code the job runs.

## Decision

Do not give `CACHE_ACCESS_TOKEN` to `pull_request` jobs, including same-repo and
owner-authored PRs. Do not use `pull_request_target` to work around that.
Validate on `push` to `main` (and `workflow_dispatch` on `main`) may write.
Agents keep the write token. PR validate stays on the read token.

## Consequences

The first post-merge validate on `main` can PUT; later PRs GET those hashes.
`workflow_dispatch` on a non-`main` ref stays read-only. Revisit only if
validate is rewritten so the privileged job is defined only on the default
branch and never executes PR-controlled workflow or checkout while holding the
write token.
