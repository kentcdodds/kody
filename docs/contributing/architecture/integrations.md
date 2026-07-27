# OAuth integrations (apps and connections)

Saved third-party OAuth config is a first-class per-user primitive: an **OAuth
app** (shared client credentials and provider endpoints) plus one or more
**connections** (connected accounts that share that app). Credential _values_
never enter these tables — they live in the secret store and are referenced by
name.

Data access lives under `packages/worker/src/integrations/`. MCP capabilities
live under `packages/worker/src/mcp/capabilities/integrations/`. The hosted
connect UI is `/connect/oauth`.

## App / connection split

An **OAuth app** (`user_oauth_apps`) holds the provider client identity and
endpoint config that many connections can share:

- `client_id` (inline non-secret identifier)
- `client_secret_secret_name` (secret-store name, or null for public PKCE apps)
- `token_url`, optional `authorize_url` / `api_base_url`
- `flow` (`pkce` | `confidential`), optional `use_pkce`, `token_exchange_style`,
  `scope_separator`, and `extra_authorize_params_json`

A **connection** (`user_integrations`) is one connected account on that app:

- `name` (canonical integration key agents pass to `createAuthenticatedFetch`)
- `app_slug` (composite FK to the owning app)
- `scopes_json`, `required_hosts_json`
- `access_token_secret_name` and optional `refresh_token_secret_name`
- optional `account_label` / `description`, plus connect/refresh timestamps

The split exists so rotating client credentials is one write on the shared app
instead of one write per connection. Multiple Google accounts share one app; `x`
and `x-kodykoala` share one app when their app-level fields match. Two
connections that share a client id but reference different client-secret names
remain separate apps (for example `github` vs `github-kent`).

Composite primary keys `(user_id, slug)` / `(user_id, name)` and the composite
FK `(user_id, app_slug) → user_oauth_apps(user_id, slug)` keep per-user
isolation structural. The connection FK uses `ON DELETE RESTRICT`, so
connections must be removed before their app.

## Where credentials live

| Field         | Storage                     | Notes                                     |
| ------------- | --------------------------- | ----------------------------------------- |
| Client id     | `user_oauth_apps.client_id` | Non-secret OAuth client identifier        |
| Client secret | Secret store                | Referenced by `client_secret_secret_name` |
| Access token  | Secret store                | Referenced by `access_token_secret_name`  |
| Refresh token | Secret store                | Referenced by `refresh_token_secret_name` |

Account export includes both tables. Rows contain secret _names_ and the inline
`client_id`, never encrypted secret payloads. Exporting `client_id` is
deliberate: it is a non-secret OAuth client identifier, not a credential value.

## Two independent host gates

Outbound OAuth calls enforce two allowlists that are not collapsed:

1. **Connection `requiredHosts`** (plus the host of `apiBaseUrl`) — enforced by
   `createAuthenticatedFetch` / `assertIntegrationHostAllowed` before an OAuth
   bearer token is attached. A materialized token is not a `{{secret:…}}`
   placeholder, so the fetch gateway cannot apply secret host policy to it.
2. **Each secret's `allowedHosts`** — enforced when secret placeholders resolve
   through the fetch gateway (client secret on token exchange, token mounts, and
   similar paths).

Both must allow a destination for the full connect → refresh → API call path to
succeed. See the
[OAuth integration host allowlist](./index.md#oauth-integration-host-allowlist)
note on the architecture index.

## `/connect/oauth` and authenticated fetch

`/connect/oauth` runs authorize → callback → token exchange in the browser
session, writes access/refresh tokens through the account secrets flow, and
upserts the app + connection via the integrations service. Reconnect with
`?provider=<integration-name>` reuses saved authorize metadata (scopes,
`scopeSeparator`, `extraAuthorizeParams`) and the current app client
credentials.

`createAuthenticatedFetch(providerName)` (execute runtime helper) loads the
named connection joined to its app, refreshes the access token when needed, and
returns a fetch wrapper that:

1. asserts the request host against the connection allowlist
2. attaches the bearer token only after that check passes

Capability and search detail surfaces keep a **flat connection-shaped** config
(`clientId`, secret names, endpoints, `authorization`, `requiredHosts`) so
callers do not need to join app and connection themselves.

## Account UI

`/account/integrations` lists connections grouped under the OAuth app they
share. Each app also has its own page at `/account/integrations/apps/:appSlug`
(a connection named `apps` still resolves at `/account/integrations/apps`). The
app page shows provider metadata, client id, client-secret secret name (never
values), endpoints, flow / PKCE / exchange style, timestamps, and the
connections that would be affected by a credential rotation. The rotate form
posts to `/account/integrations.json` with
`action: "rotate_oauth_app_credentials"`: it stores a new client-secret value in
the secret store (when provided), then calls `rotateOauthAppClientCredentials`
so every sibling connection picks up the new client id / secret name on the next
join.

## Capability surface

Domain: `integrations`
(`packages/worker/src/mcp/capabilities/integrations/domain.ts`).

| Capability                                             | Role                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `integration_save` / `_get` / `_list` / `_delete`      | Connection CRUD with flat `clientId` output                   |
| `integration_oauth_app_list`                           | Apps with connection counts and sibling connection names      |
| `integration_oauth_app_rotate_credentials`             | Rotate shared app `clientId` / client-secret name             |
| `integration_registry_search` / `integration_discover` | Untrusted integrations.sh research                            |
| `openapi_spec_summarize` / `openapi_client_scaffold`   | Spec research helpers (bindings live in the `openapi` domain) |

OpenAPI provider bindings (`user_openapi_bindings` /
`user_openapi_binding_operations`) are a separate primitive; see
[OpenAPI provider bindings](./openapi-bindings.md).

## Account deletion order

Deletion targets in `account-data-targets.ts` list `user_integrations` before
`user_oauth_apps` so the `ON DELETE RESTRICT` FK cannot block cleanup when
cascades are disabled. OpenAPI binding cleanup (child operations before parent
bindings) is documented in
[OpenAPI provider bindings](./openapi-bindings.md#account-deletion-order).

## Related docs

- [Data storage](./data-storage.md) — D1 inventory and JSON shadow schemas
- [OAuth guide](../../guides/oauth.md) — agent-facing `/connect/oauth` workflow
- [Primitives map](./primitives.yaml) — `integrations` primitive and
  `integration-host-allowlist` invariant
