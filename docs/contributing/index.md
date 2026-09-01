# Contributing to Kody

Documentation for people and agents **developing this repository**: setup, code
style, tests, MCP capabilities, and runtime architecture.

## Setup and workflow

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
- [Friction log](./friction-log.md) (file through
  `kody:@kentcdodds/friction-log/create`; daily Cursor agent investigates)

## Code and tooling

- [Code style](./code-style.md), [TypeScript setup](./typescript-setup.md)
- [Import boundaries](./import-boundaries.md) (enforced app / MCP / worker /
  universal layering)
- [Oxlint JS plugins](./oxlint-js-plugins.md),
  [dependency overrides](./dependency-overrides.md)
  (`typescript/no-explicit-any`, `TODO`/`FIXME`/`HACK`, file-size ratchet, knip)
- [Remix skills and page checklist](./remix.md), [frames](./frames.md)
- [Cloudflare Agents SDK usage](./cloudflare-agents-sdk.md)

## Testing

- [Testing principles](./testing-principles.md)
- [End-to-end testing](./end-to-end-testing.md)
- [Weekly site performance](./weekly-site-perf.md)
- [Mock API servers](./mock-api-servers.md)
- [Package discovery routing evaluation](./package-discovery-evaluation.md)

## Packages and MCP

- [Packages and manifests](./packages-and-manifests.md)
- [`packageStorage()` grants and caller-owned packages](./package-storage-static-imports.md)
  (stamp/grant model under fork-only official packages and no author-facing
  invoke)
- [Package codemods](./package-codemods.md)
- [`packages.invoke` prefix migration](./package-invoke-prefix-migration.md)
  (soak telemetry for the quarantined helper leftover)
- [Public packages](./community-packages.md)
- [External package invocation API](./package-invocation-api.md)
- [Adding capabilities](./adding-capabilities.md)
- [Search entity plugins](./search-entity-plugins.md) (plugin module + registry,
  result/detail unions, list markdown, detail routing, public type lists)
- [MCP server patterns](./mcp-server-patterns.md) (reference for server design)
- [OpenAI Apps / ChatGPT plugin submission](./openai-apps-submission.md) (domain
  challenge, annotation contract, OIDC gap, Developer Mode demo cases)
- [AI chat package guide](./ai-chat-package-guide.md)
- Execute patterns:
  [Cloudflare API v4](./execute-patterns/cloudflare-api-v4.md),
  [Cloudflare developer docs](./execute-patterns/cloudflare-developer-docs.md)

## Security and operations

- [Security](./security.md), [secret host approval](./secret-host-approval.md),
  [secret rotation](./secret-rotation.md), [social login](./social-login.md)
- [Production backup and disaster recovery](./disaster-recovery.md)
- Ops runbook: [account write-lease repair](./account-write-lease-repair.md)

## Architecture

- [Architecture](./architecture/index.md) — production worker fleet, request
  lifecycle, [authorization](./architecture/authorization.md) (RBAC)

Documentation for **using** Kody as an MCP server (not building the repo) lives
under [`docs/use/`](../use/index.md). How we write and maintain those pages (and
contributing docs) is covered in [Documentation principles](./documentation.md)
(prefer a checker over a should-list).
