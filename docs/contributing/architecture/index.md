# Architecture overview

This folder documents the important runtime architecture for `kody`.

Before making product-level assumptions, read
[`../project-intent.md`](../project-intent.md). The architecture docs describe
how the system works, while the intent doc explains what the project is trying
to become.

## Core docs

- [Project Intent](../project-intent.md): current scope, goals, and non-goals
  for the project.
- [Request Lifecycle](./request-lifecycle.md): how requests are routed in the
  Worker.
- [Authentication](./authentication.md): app session auth and OAuth-protected
  MCP auth.
- [Data Storage](./data-storage.md): what is stored in D1, KV, and Durable
  Objects.
- [Home Connector](./home-connector.md): local device adapters, Samsung token
  persistence, and connector-specific discovery/runtime behavior.
- [Remote connectors](./remote-connectors.md): generic outbound WebSocket
  protocol, URLs, secrets, and MCP caller context for any `kind` / instance.
- [Local Agent Bridge Direction](./local-agent-bridge.md): proposed direction
  for securely reaching local-network systems through an outbound agent
  connection.

## OAuth connector host allowlist

The `createAuthenticatedFetch` helper (and its sandboxed prelude equivalent)
attaches a materialized OAuth bearer token to outbound requests. Because the
token is no longer wrapped in a `{{secret:…}}` placeholder at that point, the
fetch gateway's host-allowlist check cannot see it. To prevent token
exfiltration to arbitrary hosts:

- Before attaching the `Authorization` header, the helper resolves the
  connector's allowed host set from `requiredHosts` plus the host of
  `apiBaseUrl`.
- If the outbound request URL targets a host **not** in that set, the helper
  throws `ConnectorHostNotAllowedError` without making the network request and
  without including the token value in the error message.
- The reusable enforcement logic lives in
  `packages/worker/src/mcp/execute-modules/connector-host-allowlist.ts`
  (`assertConnectorHostAllowed`, `getConnectorAllowedHosts`).

This invariant must hold for any code path that materializes a connector token
and then attaches it to an outbound request.

## Source of truth in code

- Worker entrypoint: `packages/worker/src/index.ts`
- App request handler: `packages/worker/src/app/handler.ts`
- Router and HTTP route mapping: `packages/worker/src/app/router.ts` and
  `packages/worker/src/app/routes.ts`
- OAuth handlers: `packages/worker/src/oauth-handlers.ts`
- MCP auth checks: `packages/worker/src/mcp-auth.ts`
- MCP capability catalog: domain modules under
  `packages/worker/src/mcp/capabilities/*/domain.ts`, merged list in
  `packages/worker/src/mcp/capabilities/builtin-domains.ts`, built by
  `packages/worker/src/mcp/capabilities/build-capability-registry.ts`,
  re-exported from `packages/worker/src/mcp/capabilities/registry.ts` (see
  [`../adding-capabilities.md`](../adding-capabilities.md)).
