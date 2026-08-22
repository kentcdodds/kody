# Decision records

A **steering veto list**. Open the list below before proposing a new primitive,
surface, or storage home. Architecture docs and code describe how the system
works today; this folder records product-shaped decisions **already made**,
usually a no with a revisit-if.

Linked from [AGENTS.md](../../../AGENTS.md) for that check — not as homework and
not as a museum.

A good record is half a page: context, the decision, consequences. See
[0025](./0025-no-package-services-primitive.md) for the shape that actually
steers (write the no before the next agent re-proposes the primitive).

Decision records are point-in-time documents, so they are exempt from
`npm run docs:check-temporal`; everything else in `docs/` describes current
behavior (see [documentation principles](../documentation.md)).

## When to add a record

Write one after you have already decided **not** to build something the next
agent will otherwise re-propose. Copy [`0000-template.md`](./0000-template.md)
to the next unused number (read this index on `main` first) with a kebab-case
slug. Keep it to roughly half a page.

Do **not** write an ADR on every PR. Number collisions (two 0022s, then two
0028s, then two 0029s the same day) are the failure mode of that habit. If a
number collides, renumber the later record; do not leave duplicates.

Do **not** record layout or UI tweaks, mode assignments, or "we use library X"
unless that pick is a no that will otherwise be re-litigated.

When a later record changes a decision, mark the old one `superseded by NNNN`
rather than editing or deleting it, and list it under
[Historical / UI / implementation](#historical--ui--implementation).

Add new steering records to the steering list, not a catch-all numbered dump.

## Steering list

Open these before proposing a new primitive, surface, or storage home.

- [0001 — No user-facing package versioning or import pins](./0001-no-package-versioning.md)
- [0031 — `kody.dependencies` is a name-to-`*` map; still no pins or live resolution](./0031-kody-dependencies-wildcard-map.md)
- [0002 — Data placement: D1, per-user Durable Objects, Analytics Engine](./0002-data-placement.md)
- [0003 — Repos are the base primitive; packages are an explicit extension](./0003-repos-as-base-primitive.md)
- [0004 — Status page stays a separate worker with its own storage](./0004-status-page-separate-worker.md)
- [0005 — Keep the MCP legacy lane until metrics retire it; no Tasks yet](./0005-mcp-dual-lane-stateless-migration.md)
- [0006 — No repo/package CI primitive](./0006-no-repo-ci-primitive.md)
- [0007 — Keep in-house feature flags; no package flag primitive](./0007-keep-in-house-feature-flags.md)
- [0008 — No traces, previews, browser-run, gradual deploys, or session mining](./0008-declined-adlc-primitives.md)
- [0011 — Keep workers-unit per-file isolation; do not warm DOs to "fix" slowness](./0011-workers-unit-pool-harness.md)
- [0013 — Post-publish checks stay on MCP; no signed app URLs or inbox injection](./0013-synthetic-package-requests.md)
- [0014 — Platform scopes resolve live; person-account imports stay caller-owned](./0014-platform-live-packages.md)
- [0015 — Wait on Skills over MCP; serve skill content via packages](./0015-skills-over-mcp-wait.md)
- [0017 — Hosted package apps use per-user subdomains; same-owner isolation deferred](./0017-per-user-package-app-subdomains.md)
- [0020 — Repo sessions spill Workspace objects to R2; do not adopt `@cloudflare/computer`](./0020-repo-session-workspace-r2-not-computer.md)
- [0021 — Publish-gated packages; no in-process composition runtime](./0021-publish-gated-package-composition.md)
- [0022 — Retire the values primitive; do not add a thinner settings twin](./0022-retire-values-primitive.md)
- [0023 — Progressive search disclosure; no full-SDK dumps or unbounded listings](./0023-progressive-search-disclosure.md)
- [0024 — Packages outrank synthesized providers; no auto-delete or ranking toggle](./0024-packages-outrank-synthesized-providers.md)
- [0025 — No package services primitive](./0025-no-package-services-primitive.md)
- [0032 — No unattached jobs; schedules belong to packages or workflows](./0032-no-unattached-jobs.md)
- [0026 — Invocation tokens belong to one package; no account-level wildcard bearer](./0026-package-owned-invocation-tokens.md)
- [0027 — No invocation-token source allowlist](./0027-no-invocation-token-source-allowlist.md)

## Historical / UI / implementation

Accepted or superseded records that do **not** change the next product proposal.
Do not treat this list as homework. History stays; it is not silently deleted.

- [0009 — Shiki for in-app syntax highlighting](./0009-shiki-syntax-highlighting.md)
  — library pick; the highlighter is already in the app
- [0010 — One RecordTable for account and admin list/detail screens](./0010-account-record-table.md)
  — superseded by 0028; UI diary (working notes are not steering)
- [0012 — Client-safe shared code lives in `#universal/*`](./0012-universal-layer.md)
  — encoded by [import boundaries](../import-boundaries.md) and lint
- [0016 — Extract the package runtime and jobs lanes into separate workers](./0016-mono-worker-extraction.md)
  — landed; see the architecture runbooks
- [0018 — Inbound CLA for external contributions to this repository](./0018-inbound-cla.md)
  — legal/process; see [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [0019 — Self-hosted Nx remote cache (not Nx Cloud)](./0019-self-hosted-nx-remote-cache.md)
  — contributor infra, not a product primitive
- [0028 — List/detail records expand inside the table](./0028-list-detail-expand.md)
  — UI mode assignment (supersedes 0010)
- [0029 — Discord social login and official guild role](./0029-discord-social-login-and-guild-role.md)
  — superseded by 0030; invite-only membership is no longer the product path
- [0030 — Join the official Discord during social login](./0030-discord-guilds-join-on-social-login.md)
  — `guilds.join` on Discord social login; token still discarded after the
  callback
