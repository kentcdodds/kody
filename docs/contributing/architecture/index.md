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
- [Platform accounts](./platform-accounts.md): operator-provisioned platform
  accounts, package scope grants, and actor/owner delegation for official
  package scopes.
- [Authorization](./authorization.md): role-based access control (RBAC), admin
  routes, and the `any`-access exception to per-user isolation.
- [Entitlements](./entitlements.md): per-user plans (`users.plan`), per-plan
  resource limits, and the shared `assertWithinEntitlement` enforcement helper
  (NULL plan = legacy/unlimited).
- [Feature Flags](./feature-flags.md): code-registry flags with D1-backed global
  state, percentage rollouts, and per-user overrides, managed at
  `/admin/feature-flags`.
- [Data Storage](./data-storage.md): what is stored in D1, KV, and Durable
  Objects.
- [Usage Metering](./usage-metering.md): per-user usage events, the
  `recordUsage()` helper contract, and the D1 rollup table.
- [Primitives map](./primitives.yaml): stable taxonomy of system primitives and
  invariants for the visual-recap skill
  (`.agents/skills/visual-recap/SKILL.md`). It is not a living feature changelog
  and not derived from source — architecture docs and code remain the truth for
  behavior. Update the map only when adding, removing, or reshaping a primitive.
  Classify PR paths with
  `node .agents/skills/visual-recap/scripts/classify-primitives.mjs`; validate
  with `npm run primitives:check`.
- [Remote connectors](./remote-connectors.md): generic outbound WebSocket
  protocol, URLs, secrets, and MCP caller context for any `kind` / instance.
- [MCP client servers](./mcp-client-servers.md): user-added remote MCP servers
  Kody connects to as a client (per-user hub Durable Object, OAuth flow, and
  `kody.mcp[...]` capability synthesis).
- [OpenAPI provider bindings](./openapi-bindings.md): user-scoped curated
  OpenAPI bindings with runtime-synthesized `openapi:<name>` domains callable
  via `kody.openapi[...]` (host approval never widened by untrusted specs).
- [Local Agent Bridge Direction](./local-agent-bridge.md): proposed direction
  for securely reaching local-network systems through an outbound agent
  connection.

## OAuth integration host allowlist

The `createAuthenticatedFetch` helper (and its sandboxed prelude equivalent)
attaches a materialized OAuth bearer token to outbound requests. At that point,
the outbound token is not a `{{secret:…}}` placeholder, so the fetch gateway's
host-allowlist check cannot inspect it. To prevent token exfiltration to
arbitrary hosts:

- Before attaching the `Authorization` header, the helper resolves the
  integration's allowed host set from `requiredHosts` plus the host of
  `apiBaseUrl`.
- If the outbound request URL targets a host **not** in that set, the helper
  throws `IntegrationHostNotAllowedError` without making the network request and
  without including the token value in the error message.
- The reusable enforcement logic lives in
  `packages/worker/src/mcp/execute-modules/integration-host-allowlist.ts`
  (`assertIntegrationHostAllowed`, `getIntegrationAllowedHosts`).

This invariant must hold for any code path that materializes an integration
token and then attaches it to an outbound request.

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
  `packages/worker/src/mcp/capabilities/build-capability-registry.ts`, memoized
  for builtins via `getStaticRegistry()` and resolved per request via
  `getCapabilityRegistryForContext()` in
  `packages/worker/src/mcp/capabilities/registry.ts` (see
  [`../adding-capabilities.md`](../adding-capabilities.md)).
- Workflow runtime hub:
  `packages/worker/src/package-runtime/package-workflows.ts` defines the shared
  `DynamicCallableWorkflow` Cloudflare Workflow used by every runtime context.
  Runtime injection is wired through
  `packages/worker/src/mcp/run-kody-registry.ts` for bundled code and
  `packages/worker/src/package-runtime/package-app.ts` for package apps.
