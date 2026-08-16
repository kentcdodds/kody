# Contributing to Kody

Documentation for people and agents **developing this repository**: setup, code
style, tests, MCP capabilities, and runtime architecture.

## Setup and workflow

- [Getting started](./getting-started.md), [project intent](./project-intent.md)
- [Decision records](./decisions/index.md) (ADRs, including decisions **not** to
  build something)
- [Inbound contributions](./inbound-contributions.md) (CLA for patches to this
  repository)
- [Setup](./setup.md), [environment variables](./environment-variables.md),
  [setup manifest](./setup-manifest.md)
- [Manual PR preview testing](./preview-manual-testing.md)
- [Optional Cloudflare offerings](./cloudflare-offerings.md)
- [Cursor Cloud Agent notes](./cloud-agents.md)
- [Harness engineering](./harness-engineering.md) (agent-first loop, promoting
  lessons into enforcement)

## Code and tooling

- [Code style](./code-style.md), [TypeScript setup](./typescript-setup.md)
- [Import boundaries](./import-boundaries.md) (enforced app / MCP / worker /
  universal layering)
- [Oxlint JS plugins](./oxlint-js-plugins.md),
  [dependency overrides](./dependency-overrides.md)
- [Remix skills and page checklist](./remix.md), [frames](./frames.md)
- [Cloudflare Agents SDK usage](./cloudflare-agents-sdk.md)

## Testing

- [Testing principles](./testing-principles.md)
- [End-to-end testing](./end-to-end-testing.md)
- [Mock API servers](./mock-api-servers.md)
- [Package discovery routing evaluation](./package-discovery-evaluation.md)

## Packages and MCP

- [Packages and manifests](./packages-and-manifests.md)
- [Package codemods](./package-codemods.md)
- [Community packages](./community-packages.md)
- [External package invocation API](./package-invocation-api.md)
- [Adding capabilities](./adding-capabilities.md)
- [Search entity plugins](./search-entity-plugins.md) (plugin module + registry,
  result/detail unions, list markdown, detail routing, public type lists)
- [MCP server patterns](./mcp-server-patterns.md) (reference for server design)
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

- [Architecture](./architecture/index.md) — includes
  [authorization](./architecture/authorization.md) (RBAC)

Documentation for **using** Kody as an MCP server (not building the repo) lives
under [`docs/use/`](../use/index.md). How we write and maintain those pages (and
contributing docs) is covered in [Documentation principles](./documentation.md).
