# 0043: Repo visibility is the share switch; no community-package kind

- **Status:** accepted
- **Date:** 2026-08-31

## Context

Public/private lived on `package.json#private` and was projected to
`saved_packages.is_private`. Community listings were a second publish verb
(`community_publish`) with MIT, README Intent, and logo-shaped gates, plus a
teaser state (public-but-unlisted) and an admin **trusted** badge that does not
scale. ADR [0003](./0003-repos-as-base-primitive.md) already made repos the base
primitive; visibility was still modeled as a package/npm field.

## Decision

Do not keep a second “community package” kind, a second publish verb, a license
bureau, or a trusted-listing review badge.

- Visibility lives on the repo record (D1), default private, not derived from
  `package.json#private`.
- Public ⇔ the default-branch HEAD is world-readable and forkable, and the repo
  appears on `/community` and `/@username/:name`. Package **runtime** still uses
  `published_commit`.
- Private ⇔ owner only. Hidden and locked stay separate jobs.
- No MIT, logo, or Intent gates. Featured stays as onboarding editorial.
- Forks copy HEAD into an inert source. Behind-upstream compares origin HEAD to
  the last absorbed SHA, recorded on the forker’s publish.
- Catalog discovery stays out of general `search`.

## Consequences

Teaser packages (`private: false` with no listing) backfill to **private**.
Active listings backfill to **public**. `community_publish` /
`community_set_trusted` / `community_fork_absorb` go away. Revisit if Kody needs
a real review program or SPDX matrix; do not re-add a twin publish verb or a
`package.json` visibility field.
