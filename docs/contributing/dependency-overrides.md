# Dependency overrides

This file documents every `overrides` entry in the root `package.json` and
explains why it exists. When adding or removing an override, update this file in
the same commit.

After changing overrides, run `npm run audit:prod` as a diagnostic check on
production dependencies — it is not the merge gate. Use `npm run validate` as
the single authoritative read-only merge gate (see [`setup.md`](./setup.md)).
Clearing these override targets does not mean the whole production audit is
clean — other transitive packages can still report advisories outside this
file's scope.

## Production overrides

### `@modelcontextprotocol/sdk` → `1.29.0`

The MCP SDK is pinned to a single version so that all workspaces resolve the
same copy. Without this override, npm may hoist conflicting versions from
transitive consumers (`agents`, `@kody/worker`).

### `hono` → `>=4.12.27 <5.0.0`

Keeps the transitive hono copy at or above the current advisory floor. Upstream
`@modelcontextprotocol/sdk@1.29.0` still declares `hono@^4.11.4`, which allows
vulnerable releases below `4.12.27`, so this override cannot be removed yet.

Notable patched floors covered by `>=4.12.27` include:

- [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj) —
  hono/jsx context not isolated per request (`>=4.11.8, <4.12.27`)
- [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59) —
  server-side XSS via JSX escaping bypass in `cx()` (`>=4.0.0, <4.12.27`)
- [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) — API
  Gateway v1 adapter can drop a distinct repeated header value
  (`>=4.3.3, <4.12.27`)
- Earlier floors through `4.12.14` / `4.12.25` for cookie, SSR, CORS,
  `serveStatic`, JWT, cache middleware, and related issues

The upper bound `<5.0.0` keeps the override within the same major version to
avoid breaking changes.

### `@hono/node-server` → `>=2.0.10 <3.0.0`

Keeps the transitive `@hono/node-server` copy at or above the current advisory
floor. Upstream `@modelcontextprotocol/sdk@1.29.0` still declares
`@hono/node-server@^1.19.9`. That 1.x range cannot reach the patched 2.x
releases, so this override forces a major bump and cannot be removed yet.

Advisories requiring the 2.x floor:

- [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) —
  path traversal in `serve-static` on Windows via encoded backslash (`%5C`)
  (vulnerable `<2.0.5`, including all remaining 1.x releases)
- [GHSA-9mqv-5hh9-4cgg](https://github.com/advisories/GHSA-9mqv-5hh9-4cgg) —
  follow-on 2.x issue (`>=2.0.0, <=2.0.9`, patched `2.0.10`)

The older 1.x floor (`>=1.19.13`) only addressed
[GHSA-92pp-h63x-v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m) and is
stale relative to the advisories above. The upper bound `<3.0.0` keeps the
override within the forced 2.x major.

### `postcss` → `>=8.5.10 <9.0.0`

Resolves a moderate advisory in postcss <8.5.10:

- [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS
  via unescaped `</style>` in CSS stringify output

PostCSS is pulled transitively by Vite (via `agents` / `vitest`). Upstream Vite
still declares `postcss@^8.5.8`, which allows `8.5.8` / `8.5.9`, so this
override cannot be removed yet even though a fresh resolve often lands on a
newer 8.5.x. No newer PostCSS advisory has raised the patched floor beyond
`8.5.10`. The upper bound `<9.0.0` keeps the override within the same major
version to avoid breaking changes.
