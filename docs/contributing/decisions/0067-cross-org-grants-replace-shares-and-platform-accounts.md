# 0067 — Cross-org grants replace package shares and platform accounts

- **Status:** accepted
- **Date:** 2026-10-09
- **Supersedes:** [0050](./0050-package-share-grants-are-not-scope-grants.md),
  [0014](./0014-platform-live-packages.md),
  [0035](./0035-platform-packages-execute-only.md),
  [0036](./0036-platform-packages-fork-only.md)

## Context

Three special cases carried one idea each that organizations now cover.
`package_share_grants` let one person invite another to **use** one package
([0050](./0050-package-share-grants-are-not-scope-grants.md)).
`package_scope_grants` gave a person full authoring inside a **platform**
account scope. Platform accounts (`users.account_type = 'platform'`) were
accounts that the operator owned, whose packages resolved live and were injected
into every user's search ([0014](./0014-platform-live-packages.md),
[0035](./0035-platform-packages-execute-only.md),
[0036](./0036-platform-packages-fork-only.md)).

0050 kept shares and scope grants apart because there was no org to hold
membership. With orgs, memberships, and grants
([0063](./0063-teams-expand-orgs.md), [0062](./0062-one-access-check.md)), that
reason is gone. Production held one platform account (`kody`), no cross-platform
dependencies, and no imports of shared packages, so the conversion carries no
compatibility burden.

## Decision

- **Shares are grants.** An accepted share becomes a `use` grant
  (`package:read`, `package:execute`) from the owner's org to the grantee. A
  pending share becomes a grant invite. Revoked and left shares are dropped.
  `trust_level` and `accepted_published_commit` (pin and follow) are dropped: a
  grant has no publish trust.
- **Scope grants are Owner memberships.** Each grantee becomes an `owner` of the
  scope owner's org. There is no second "authoring" table.
- **Platform accounts are ordinary orgs.** A platform account's org is paid
  (`plan = pro`, `admin_credits_eligible = 1`). Only `@kody` receives the $1,000
  site-admin credit. Its packages are ordinary public or private org packages:
  nothing marks them as platform or verified, and no code injects them into
  anyone's search or skills.
- **Cross-org rule.** A package imports only packages from its own org. Access
  across orgs is a grant to run or read, never a live dependency. To reuse
  another org's public package, fork it.
- **Retired-plan subscribers keep their current prices.** The conversion does
  not touch Stripe or subscriber billing.

Migration `0091-teams-sharing-platform-conversion.sql` converts the data and
fails closed on the invariants above. The old tables and `users.account_type`
stay until the P9 contract drop.

## Consequences

One access model covers sharing, platform authoring, and teams.
`resolveShareGrantedPackageImport`, the platform-package search and skills
injections, and the share and scope-grant capabilities are removed in the same
series. Old share invite links stop working because converted invites carry
fresh tokens; owners re-send them.

**Revisit-if** a share needs publish trust again (a guest who must pin an
owner's commits) or an official catalog needs verified or featured treatment.
Either becomes a generic org or grant setting, not a platform account type.
