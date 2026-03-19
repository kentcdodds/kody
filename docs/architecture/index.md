# Architecture overview

This folder documents the important runtime architecture for `kody`.

Before making product-level assumptions, read
[`../project-intent.md`](../project-intent.md). The architecture docs describe
how the system currently works, while the intent doc explains what the project
is trying to become.

## Core docs

- [Project Intent](../project-intent.md): current scope, goals, and non-goals
  for the project.
- [Request Lifecycle](./request-lifecycle.md): how requests are routed in the
  Worker.
- [Authentication](./authentication.md): app session auth and OAuth-protected
  MCP auth.
- [Data Storage](./data-storage.md): what is stored in D1, KV, and Durable
  Objects.
- [Local Agent Bridge Direction](./local-agent-bridge.md): proposed direction
  for securely reaching local-network systems through an outbound agent
  connection.

## Source of truth in code

- Worker entrypoint: `worker/index.ts`
- Server request handler: `server/handler.ts`
- Router and HTTP route mapping: `server/router.ts` and `server/routes.ts`
- OAuth handlers: `worker/oauth-handlers.ts`
- MCP auth checks: `worker/mcp-auth.ts`
- MCP capability catalog: domain modules under `mcp/capabilities/*/domain.ts`,
  merged list in `mcp/capabilities/builtin-domains.ts`, built by
  `mcp/capabilities/build-capability-registry.ts`, re-exported from
  `mcp/capabilities/registry.ts` (see
  [`../agents/adding-capabilities.md`](../agents/adding-capabilities.md)).
