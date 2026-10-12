# 0070: User-owned API tokens and persistent git HTTPS auth

- **Status:** accepted
- **Date:** 2026-10-12
- **Amends:** [0056](./0056-cli-credential-bootstrap.md) (CLI bootstrap mint
  default), [0064](./0064-oauth-org-binding.md) (org selection for API tokens)

## Context

CLI bootstrap tokens were fixed to one `org_id` at mint time. Agents and humans
who work across personal and team orgs needed either many tokens or a re-login.
Git clone of private packages had no origin URL: only MCP-minted Artifacts
remotes. The approved design is `kody auth setup-git` with a credential helper
against `https://kody.codes/@owner/name.git`, modeled on GitHub's persistent PAT
helper — not a short-lived per-repo mint.

## Decision

- **Additive user-owned tokens:** `api_tokens.org_binding` is `org` (default,
  existing rows) or `user`. User-owned tokens pick the org per request with
  `?org=<slug>` (default personal). Membership and grants are checked live.
  Existing org-bound tokens and in-flight org-bound bootstrap codes keep
  working; no forced cutover.
- **New CLI bootstraps** mint `org_binding: user` by default.
- **Persistent git auth:** after one `kody auth setup-git`, the credential
  helper stores the user's long-lived `kody_at_…`. The origin `.git` smart HTTP
  proxy accepts that token via Basic or Bearer on every request (checked every
  time). There is no short-lived `kody_gt_…` and no `POST /v1/git/credentials`.
- **Push in scope:** when the caller has `package:write` on the target, push
  (`git-receive-pack`) is allowed. Plain repos update live HEAD; packages move
  live HEAD only (no auto-publish). Access-based Artifacts tokens: write if the
  user can write, else read. Clear git-visible denial messages when auth is
  present but write is denied.
- **Anonymous public** package clone stays published-snapshot read-only.
  Existing Artifacts remotes (`packageGetGitRemote` / `repoGetGitRemote`) are
  unchanged.

## Consequences

- CLI `--org` maps to `?org=` on Open API / CapabilityProxy (not a custom
  header; the API edge strips those). Git URLs do not use `?org=`; authz uses
  the resource owner's org.
- Leaving an org no longer needs to revoke user-owned tokens; checks fail closed
  on the next call. Org-bound tokens are still revoked on leave. Revoking the
  API token (`token:delete`) stops git on the next request.
- Non-public anonymous `.git` URLs return `401` (credential challenge) instead
  of `404`, so git invokes the helper. After auth, no read access still `404`.
- Contract for the CLI agent: [auth-setup-git](../../guides/auth-setup-git.md)
  (`guide:auth_setup_git`).
- **Revisit-if:** SSH, or a forced retirement of org-bound API tokens.
