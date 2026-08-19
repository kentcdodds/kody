# 0022: Retire the values primitive

- **Status:** accepted
- **Date:** 2026-08-19

## Context

Values were the readable twin of secrets: named non-secret config, scoped `user`
/ `app` / `session`, first-class in `search`, editable at `/account/values`.
Production D1 (2026-08-19) does not support that job.

All 122 `value_entries` rows are `user` scope (zero `app` / `session`). The
operator account holds 66. Seventeen other users hold 56; five of those users
have only `onboardingChecklistDismissed` (a platform UI flag). The rest are
OAuth client ids, chunked blobs, or a handful of package knobs. Power-user
packages already call user values "legacy" and persist config in repos plus
`packageStorage()`. Memories already hold the overlapping facts (timezone,
address). ADR [0003](./0003-repos-as-base-primitive.md) named "documents live
chunked in values" as the problem repos were meant to end. Admin insights counts
memories and secrets, not values.

The leftover unique job — deterministic cross-package `value_get({ name })` — is
a handful of Discord/org ids. That does not justify a four-capability domain, a
search entity that prints stored contents, an account screen, and two D1 tables.
Secrets stay: their contract (raw values never enter prompts) is unique. Values
were the readable twin; we do not need a twin.

## Decision

Retire the values primitive. Absorb its jobs into memories (durable facts and
preferences), package storage (runtime state and package-owned settings), repos
(versioned config), integrations (OAuth client ids), and a `users` column for
platform onboarding dismissal. Do not add a thinner "account settings" primitive
unless, after the soak, something still has no home.

The [values retirement runbook](../architecture/values-retirement-runbook.md) is
the executable plan: about thirty days of deprecation, then removal when the
mechanical gates there hold — not on a calendar date alone. Agents for users who
still have stored values learn about the retirement from a compact MCP
server-instruction notice that points at
`coding_guide_get({ guide: "values" })`. Users with no live value rows do not
see that notice.

## Consequences

MCP, search, `/account/values`, export/deletion, and entitlements byte math lose
a surface. Shared D1 write traffic for `value_entries` goes away
([0002](./0002-data-placement.md) listed values as D1 config; that placement
becomes moot when the tables drop). Community listings and packages that still
say `value_get` need a migration pass. Revisit only if a real cross-package
config need appears that memories plus a settings package cannot cover.
