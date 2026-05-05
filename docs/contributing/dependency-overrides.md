# Dependency overrides

This file documents every `overrides` entry in the root `package.json` and
explains why it exists. When adding or removing an override, update this file in
the same commit.

Run `npm run audit:prod` to verify that production dependencies remain free of
known vulnerabilities.

## Production overrides

### `@modelcontextprotocol/sdk` → `1.29.0`

The MCP SDK is pinned to a single version so that all workspaces resolve the
same copy. Without this override, npm may hoist conflicting versions from
transitive consumers (`agents`, `@kody/worker`).

### `hono` → `>=4.12.14 <5.0.0`

Resolves multiple moderate advisories in hono ≤4.12.13:

- [GHSA-26pp-8wgv-hjvm](https://github.com/advisories/GHSA-26pp-8wgv-hjvm) —
  missing validation of cookie name in `setCookie()`
- [GHSA-r5rp-j6wh-rvv4](https://github.com/advisories/GHSA-r5rp-j6wh-rvv4) —
  non-breaking space prefix bypass in `getCookie()`
- [GHSA-xf4j-xp2r-rqqx](https://github.com/advisories/GHSA-xf4j-xp2r-rqqx) —
  path traversal in `toSSG()`
- [GHSA-wmmm-f939-6g9c](https://github.com/advisories/GHSA-wmmm-f939-6g9c) —
  middleware bypass via repeated slashes in `serveStatic`
- [GHSA-458j-xx4x-4375](https://github.com/advisories/GHSA-458j-xx4x-4375) —
  HTML injection in hono/jsx SSR
- [GHSA-xpcf-pg52-r92g](https://github.com/advisories/GHSA-xpcf-pg52-r92g) —
  incorrect IP matching in `ipRestriction()` for IPv4-mapped IPv6

The transitive consumer is `@modelcontextprotocol/sdk` (declares
`hono@^4.11.4`). The upper bound `<5.0.0` keeps the override within the same
major version to avoid breaking changes.

### `@hono/node-server` → `>=1.19.13 <2.0.0`

Resolves a moderate advisory in @hono/node-server <1.19.13:

- [GHSA-92pp-h63x-v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m) —
  middleware bypass via repeated slashes in `serveStatic`

The transitive consumer is `@modelcontextprotocol/sdk` (declares
`@hono/node-server@^1.19.9`). The upper bound `<2.0.0` keeps the override within
the same major version to avoid breaking changes.

### `postcss` → `>=8.5.10 <9.0.0`

Resolves a moderate advisory in postcss <8.5.10:

- [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS
  via unescaped `</style>` in CSS stringify output

PostCSS is pulled transitively by Vite (via `vitest` in devDependencies). The
upper bound `<9.0.0` keeps the override within the same major version to avoid
breaking changes.
