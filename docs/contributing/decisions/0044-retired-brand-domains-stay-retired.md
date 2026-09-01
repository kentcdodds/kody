# 0044: Retired brand domains stay retired

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The public product origins are `kody.codes` (app), `kody.run` (hosted package
apps), and `status.kody.codes`. Earlier brand hosts — `heykody.app`,
`heykody.dev`, and `kodyapps.dev` — were dual-served through `APP_LEGACY_HOSTS`
/ `PACKAGE_APP_LEGACY_HOSTS` and inbound email aliases so bookmarks, MCP
clients, and published package URLs kept working. Those migration windows closed
(cleanup #1300 and #1428). The generic dual-serve vars remain for a future
origin move; they are not a home for the retired brand names.

## Decision

Do not re-attach `heykody.app`, `heykody.dev`, or `kodyapps.dev` as app,
package-app, status, or email hosts. Do not re-add `status.heykody.dev` as a
status-worker custom domain or deploy healthcheck fallback. Do not accept
inbound mail on `heykody.app`, `heykody.dev`, or `inbox.heykody.*`.

## Consequences

Production Wrangler commits only the canonical origins. GitHub `APP_LEGACY_*` /
`PACKAGE_APP_LEGACY_*` overlays stay empty. Package codemods `0003` and `0004`
remain so published trees that still mention the old hosts can rewrite to
`kody.codes` / `kody.run`. Retired zones may keep answering only as
Cloudflare-level redirects to the canonical hosts; they are not product
surfaces.

Revisit if a retired hostname must become a product origin again (new brand
cutover, registrar constraint, or a documented traffic gate that the canonical
host cannot serve).
