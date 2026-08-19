# 0026: Package-owned invocation tokens

- **Status:** accepted
- **Date:** 2026-08-19

## Context

Package invocation tokens let a trusted external client call
`POST /@:username/api/package-invocations/:kodyId/:exportName`. The HTTP path
already names the owner and the package. The token table nevertheless stored
cross-package JSON allowlists (`package_ids_json`, `package_kody_ids_json`,
including `*`), denormalized user identity, and a global unique `token_hash`
index. Auth hashed the bearer and looked up across every user, then checked that
the path matched the grant. A standalone `/account/package-invocation-tokens`
page existed to edit those grants.

That model treated a token as a personal access token. Webhooks already do the
opposite: resolve `@username` and the package from the URL, then compare a
secret on that package's row. Production had seven token rows across three
users; the multi-package and `*` rows were launchers and deploy clients, not a
reason to keep a grant table.

## Decision

An invocation token belongs to exactly one saved package. Auth resolves the
owner and package from the URL, then looks up
`(user_id, package_id, token_hash)`. There is no cross-package grant, no
account-level token page, and no global hash index. Export and source allowlists
stay as restrictions _within_ that package. Tokens are created, rotated, and
revoked from the package details page.

Cross-package HTTP clients call one package (an orchestrator or a discovery
package) and use `packages.invoke` inside Kody, or they speak MCP. They do not
hold a wildcard bearer.

## Consequences

Package delete removes that package's tokens. The same raw bearer may exist on
two packages only if two rows share the hash. `last_used_at` is a `waitUntil`
write and does not gate authentication. Identity for audit comes from the
resolved user, not columns on the token row. MCP lists tokens for one package;
`package_get` includes the same metadata.

The 0017 migration maps single-package grants, expands concrete multi-package
grants into one row per owned package (same hash, new ids), and drops `*` and
other unmapped rows. A row that lists packages in both legacy arrays is treated
as multi-package and exploded from the union. Rewrite `*` rows to a concrete
owned package (typically `raycast`) before 0017 runs. Do not apply 0017 on
production until the new worker is deployed: older workers still read the grant
columns. Cross-package HTTP launchers call the `raycast` package's `invoke`
export, which uses `packages.invoke` internally.
