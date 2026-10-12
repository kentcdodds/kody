# 0070: User-owned API tokens and short-lived git credentials

- **Status:** accepted
- **Date:** 2026-10-12
- **Amends:** [0056](./0056-cli-credential-bootstrap.md) (CLI bootstrap mint
  default), [0064](./0064-oauth-org-binding.md) (org selection for API tokens)

## Context

CLI bootstrap tokens were fixed to one `org_id` at mint time. Agents and humans
who work across personal and team orgs needed either many tokens or a re-login.
Git clone of private packages had no origin URL: only MCP-minted Artifacts
remotes. The approved design is `kody auth setup-git` with a credential helper
against `https://kody.codes/@owner/name.git` (clone/fetch only).

## Decision

- **Additive user-owned tokens:** `api_tokens.org_binding` is `org` (default,
  existing rows) or `user`. User-owned tokens pick the org per request with
  `?org=<slug>` (default personal). Membership and grants are checked live.
  Existing org-bound tokens and in-flight org-bound bootstrap codes keep
  working; no forced cutover.
- **New CLI bootstraps** mint `org_binding: user` by default.
- **Git credentials:** `POST /v1/git/credentials` mints a ~1h `kody_gt_…`
  password scoped to one `@owner/name.git`. The origin `.git` proxy accepts that
  credential for private packages and plain repos the user can read; anonymous
  public package clone stays as today; push stays refused.

## Consequences

- CLI `--org` maps to `?org=` on Open API / CapabilityProxy (not a custom
  header; the API edge strips those).
- Leaving an org no longer needs to revoke user-owned tokens; checks fail closed
  on the next call. Org-bound tokens are still revoked on leave.
- Non-public anonymous `.git` URLs return `401` (credential challenge) instead
  of `404`, so git invokes the helper. After auth, no access still `404`.
- Contract for the CLI agent: [auth-setup-git](../../guides/auth-setup-git.md)
  (`guide:auth_setup_git`).
- **Revisit-if:** push over the same URL, SSH, or a forced retirement of
  org-bound API tokens.
