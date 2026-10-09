# 0061 — One request context for every request source

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Each entry point (browser session, MCP OAuth, CLI, Open API token, package app,
jobs, webhooks, email and platform subscriptions, package events, workflows,
sealed secret providers) built its own caller context and answered "whose data,
who is acting, who pays, what authenticated this" in its own way. ADR 0060 added
`actor` and `owner` ids to caller contexts, but nothing read them, and
Automation runs had no way to say they had no actor. Org permissions need one
shape to check.

## Decision

- `RequestContext` (`org`, `actor`, `attribution`, `credential`, `membership`)
  is the one shape every request carries. It replaces the `actor` / `owner`
  fields from ADR 0060 on `McpCallerContext` and `AuthenticatedAppUser`.
- Every caller context names its `RequestSource`; `createMcpCallerContext`
  requires it. `deriveRequestContext` is the only builder, and
  `resolveOrgBinding` is the only place that decides the org and role.
- Automation (schedule, webhook, inbound email, platform event) has no actor and
  no membership; attribution names the source.
- Runs started by another run inherit its lineage (actor, attribution,
  credential). Lineage is persisted on workflow payloads and package event
  messages and re-validated when read. Payloads without lineage run as
  Automation.
- The request context is derived, never persisted: job caller contexts and MCP
  agent props stay byte-identical.
- The internal `PackageInvocationActor` becomes `{ sourceId, orgId, request }`.
  `sourceId` keeps the frozen synthetic ids (`internal:webhook:<id>`, …) that
  key the idempotency ledger and the automation entitlement skip.
- The `internal:package-runtime` / `internal:execute-runtime` token ids had no
  producer (nested `kody:@` imports reuse the parent caller context) and are
  removed.

We do **not**:

- add org tables, roles beyond the implicit Owner, or org switching
- move storage keys off `user.userId` (equal to `org.id` for personal orgs)
- narrow API tokens by org permission yet: `credential.scopes` is `null`
  everywhere and the legacy token scope check stays at the Open API boundary

## Consequences

Org memberships change one function body. New entry points fail to compile until
they name a source. Readers of `request` must handle `actor: null`. See
[Request context](../architecture/request-context.md).
