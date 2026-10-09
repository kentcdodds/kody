# Contributing to Kody

Documentation for people and agents **developing this repository**: setup, code
style, tests, MCP capabilities, and runtime architecture.

## Setup and workflow

- [Engineering principles](../principles/index.md)
- [Getting started](./getting-started.md), [project intent](./project-intent.md)
- [Decision records](./decisions/index.md) (steering veto list: product-shaped
  nos and durable constraints — not an ADR-per-PR log)
- [0033 memory auto-surface lab](./decisions/0033-memory-auto-surface-lab.md)
  (policy-grid evidence; re-run `node tools/memory-auto-surface-lab/run.mjs`)
- [Inbound contributions](./inbound-contributions.md) (CLA for patches to this
  repository)
- [Setup](./setup/index.md),
  [environment variables](./environment-variables.md),
  [setup manifest](./setup-manifest.md)
- [Manual PR preview testing](./preview-manual-testing.md)
- [Preview migration rehearsal](./preview-migration-rehearsal.md) (seed,
  snapshot, migrate, verify, restore on a branch preview; operator/CI only)
- [Teams production queries](./teams-production-queries.md) (read-only, sealed
  counts and ids before the Teams data conversion; Kent runs)
- [control-kody](./control-kody.md) (Feature Map + CLI; daily
  `@kentcdodds/verification-skill-maintain`)
- [Optional Cloudflare offerings](./cloudflare-offerings.md)
- [Cursor Cloud Agent notes](./cloud-agents.md)
- [Nx remote cache](../../packages/nx-cache/readme.md) (self-hosted HTTP cache
  shared by agents and CI)
- [Harness engineering](./harness-engineering.md) (agent-first loop, promoting
  lessons into checkers before should-lists)
- [Code health receipts](./code-health-receipts.md) (measured quality numbers
  and the oversized-file cleanup record)
- [Cleanup after migrations](./cleanup-after-migrations.md) (drop leftovers in
  the same change, or open a GitHub issue)
- [Planned breaking changes](./planned-breaking-changes.md) (leftovers that
  still work and will be removed later, including `kody_id` / `kody.id`)
- [Friction log](./friction-log.md) (when/where/how-to-fix policy; package owns
  create/file/daily at
  [@kentcdodds/friction-log](https://kody.codes/@kentcdodds/friction-log))
- [Repo health](./repo-health.md) (CI + in-repo budgets: AGENTS.md ratchet,
  Validate unit-job timing, ship-pr review-bot sort)
- Local CLI execute (when, command, failure):
  [guide:local_execute](../guides/local-execute.md) and
  [prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)
- PR system recaps (visual plan/recap blocks in PR descriptions):
  [visual-recap skill](../../.agents/skills/visual-recap/SKILL.md)

## Code and tooling

- [Code style](./code-style.md), [TypeScript setup](./typescript-setup.md)
- [Import boundaries](./import-boundaries.md) (enforced app / MCP / worker /
  universal layering)
- [Oxlint JS plugins](./oxlint-js-plugins.md),
  [dependency overrides](./dependency-overrides.md)
  (`typescript/no-explicit-any`, `TODO`/`FIXME`/`HACK`, file-size ratchet,
  vanished-copy `kody-custom/no-tautological-absence`, knip)
- [Remix skills and page checklist](./remix.md), [frames](./frames.md)
- [No-flash navigation](./no-flash-navigation.md) (load-before-commit router,
  `createRouteData` keeps the previous page until the next one is ready)
- [Cloudflare Agents SDK usage](./cloudflare-agents-sdk.md)

## Testing

- [Testing principles](./testing-principles.md)
- [End-to-end testing](./end-to-end-testing.md)
- [Weekly site performance](./weekly-site-perf.md)
- [Mock API servers](./mock-api-servers.md)
- [Package discovery routing evaluation](./package-discovery-evaluation.md)

## Packages and MCP

- [Packages and manifests](./packages-and-manifests.md)
- [Package sharing](../guides/package-sharing.md) (org access grants and
  invites;
  [0067](./decisions/0067-cross-org-grants-replace-shares-and-platform-accounts.md))
- [`packageStorage()` grants and stamp-aligned secrets](./package-storage-static-imports.md)
  (stamp/grant model when imports resolve only in the caller's org)
- [Package codemods](./package-codemods.md)
- [Public packages](./community-packages.md)
- [Inbound webhooks](../use/webhooks.md) (external HTTP knock)
- [Adding capabilities](./adding-capabilities.md)
- [Search entity plugins](./search-entity-plugins.md) (plugin module + registry,
  result/detail unions, list markdown, detail routing, public type lists)
- [MCP server patterns](./mcp-server-patterns.md) (reference for server design)
- [AI chat package guide](./ai-chat-package-guide.md)
- Execute patterns:
  [Cloudflare API v4](./execute-patterns/cloudflare-api-v4.md),
  [Cloudflare developer docs](./execute-patterns/cloudflare-developer-docs.md)

## Security and operations

- [Security](./security.md),
  [2026-09-16 codebase audit](../audits/2026-09-16-codebase-audit.md),
  [secret host approval](./secret-host-approval.md),
  [secret providers](./secret-providers.md),
  [secret rotation](./secret-rotation.md), [social login](./social-login.md)
- [Operator accounts](./operator-accounts.md) (third-party services, secret
  names, recovery)
- [Production backup and disaster recovery](./disaster-recovery.md)
- [Production rollback](./rollback.md)
- Ops runbook: [account write-lease repair](./account-write-lease-repair.md)

## Architecture

- [Architecture](./architecture/index.md) — production worker fleet, request
  lifecycle, [authorization](./architecture/authorization.md) (RBAC)

Served usage docs are [`docs/guides/`](../guides/README.md) (`guide:{id}`,
[kody.codes/docs](https://kody.codes/docs)). MCP field reference is
[`docs/use/`](../use/README.md). How we write and maintain those pages (and
contributing docs) is covered in [Documentation principles](./documentation.md)
(prefer a checker over a should-list).
