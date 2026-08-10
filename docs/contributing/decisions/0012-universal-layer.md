# 0012: Client-safe shared code lives in `#universal/*`

- **Status:** accepted
- **Date:** 2026-08-07

## Context

The browser TypeScript project must stay a DOM / `remix/ui` environment. The SPA
still needs shared route tables, loader payload types, display helpers,
permission/plan/flag registries, and style tokens. Those modules accumulated as
one-off entries in `packages/worker/tsconfig-client.json`, which grew every time
a new universal import appeared.

## Decision

Client-safe shared code lives under `packages/worker/universal/` and is imported
as `#universal/*`. The client tsconfig includes `client/**` and `universal/**`
only. Lint forbids `#app/*`, `#worker/*`, and `#mcp/*` imports from client and
universal modules.

## Consequences

New shared browser/server contracts go in `#universal/*` instead of appending
tsconfig paths. Domain folders under `packages/worker/src/` keep server-only
implementation. Revisiting this would only make sense if universal code grew
large enough to become its own package.
