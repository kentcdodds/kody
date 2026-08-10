# OAuth integrations (apps and connections)

Saved third-party OAuth config is a first-class primitive: an **OAuth app**
(shared client credentials and provider endpoints) plus one or more
**connections** (connected accounts that share that app). An app lives in one of
two lanes: **user lane** — a per-user `user_oauth_apps` row the user registered
with the provider — or **platform lane** — an operator-provisioned built-in
`platform_oauth_apps` row every user can connect to (see
[Platform (built-in) OAuth apps](#platform-built-in-oauth-apps)). Per-user
credential _values_ never enter these tables — they live in the secret store and
are referenced by name.

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

A **connection** (`user_integrations`) is one connected account on an app in
either lane:

- `name` (canonical integration key agents pass to `createAuthenticatedFetch`)
- exactly one of `app_slug` (composite FK to the owning user-lane app) or
  `platform_app_slug` (FK to `platform_oauth_apps(slug)`), enforced by a `CHECK`
  constraint
- `scopes_json`, `required_hosts_json`
- `access_token_secret_name` and optional `refresh_token_secret_name`
- optional `account_label` / `description`, plus connect/refresh timestamps

`JoinedIntegration` (`packages/worker/src/integrations/types.ts`) joins a
connection to the app that owns its client credentials as a discriminated union
with `lane: 'user' | 'platform'`, matching which slug column is set.

The split exists so rotating client credentials is one write on the shared app
instead of one write per connection. Multiple Google accounts share one app; `x`
and `x-kodykoala` share one app when their app-level fields match. Two
connections that share a client id but reference different client-secret names
remain separate apps (for example `github` vs `github-kent`).

Composite primary keys `(user_id, slug)` / `(user_id, name)` and the composite
FK `(user_id, app_slug) → user_oauth_apps(user_id, slug)` keep per-user
isolation structural. Both connection FKs use `ON DELETE RESTRICT`, so
connections must be removed before their app (user lane) and a platform app
cannot be deleted while any user's connection references it. Platform-lane
connections point at a global app row, but the connection itself and its token
secrets stay scoped by `user_id`, so per-user isolation is unaffected.

## Platform (built-in) OAuth apps

`platform_oauth_apps` (migration
`packages/worker/migrations/0004-platform-oauth-apps.sql`) holds
operator-provisioned OAuth app registrations users connect to without creating
their own provider app. The table is global (no `user_id`) — operator config
like feature flags, not user data — so it is not a per-user-isolation exception.
Rows are keyed by `slug` and carry `provider`, `label`, the inline non-secret
`client_id`, `client_secret_encrypted`, endpoints (`token_url`, `authorize_url`,
`api_base_url`), flow options (`flow`, `use_pkce`, `token_exchange_style`,
`scope_separator`, `extra_authorize_params_json`), the scope menu,
`required_hosts_json`, and `enabled`.

### Shared client secret stays server-side

The shared client secret is stored encrypted in
`platform_oauth_apps.client_secret_encrypted` (AES-GCM keyed off
`SECRET_STORE_KEY` with the dedicated purpose `platform-oauth-client-secret`;
`encryptPlatformOauthClientSecret` / `decryptPlatformOauthClientSecret` in
`packages/worker/src/mcp/secrets/crypto.ts`). It is deliberately **outside** the
user secret store (`secret_entries`): no `{{secret:…}}` placeholder can name it,
so sandboxed code has no resolution path to the shared credential.

**Invariant:** `getPlatformOauthAppClientSecret`
(`packages/worker/src/integrations/platform-apps.ts`) is the only decrypt
accessor, and its callers are host-side token-exchange paths only — the
`/connect/oauth` handler actions in
`packages/worker/src/app/handlers/account-secrets.ts` and the
`integration_token_refresh` capability. The decrypted value must never appear in
capability outputs, loader payloads, or logs. Public projections
(`platform-app-shared.ts`) expose at most a `hasClientSecret` boolean.

### Scope menu

Platform apps carry two scope lists: `allowed_scopes_json` is the verified scope
superset a connection may ever request (the menu shown when a user edits
scopes), and `default_scopes_json` is the minimal set the connect flow requests
during onboarding. Saves fold default scopes into the allowed set.

### Host-side token refresh

Both lanes refresh host-side by default through `createAuthenticatedFetch`.
`integration_token_refresh` (implemented by `refreshIntegrationTokens` in
`packages/worker/src/integrations/token-refresh.ts`) resolves the refresh token
and client secret server-side, POSTs to the provider token URL, persists rotated
tokens back to the user secret store, and returns only
`{ ok, refreshedAt, refreshTokenRotated }` — never token values. Platform
connections require this path — the shared client secret has no user-facing
secret name by design. User-lane connections may also refresh through it;
because their `tokenUrl` is user-configurable, the user lane enforces each
materialized secret's `allowed_hosts` against the token host before the request
— the same containment the fetch gateway applied when refresh ran in-sandbox via
placeholder resolution. Platform-lane destinations are operator-pinned rows, so
no user-secret allowlist applies.

On 401, `createAuthenticatedFetch` calls `integration_token_refresh` then
retries with a `{{secret:…}}` placeholder `Authorization` header, so raw tokens
never enter the sandbox heap. Package code that triggers refresh through
`createAuthenticatedFetch` does not need a secret-write (`allowed_packages`)
grant — the system persists rotated tokens host-side and the package never sees
or writes token values. `refreshAccessToken` is the raw-token helper for auth
patterns that cannot use an Authorization header (WebSockets, SDK constructors,
query-param tokens); it runs in-sandbox for user-lane integrations and throws
for platform ones (`integration_get` carries `platform: true`). Token-exchange
request building is shared:
`packages/worker/src/integrations/oauth-token-exchange.ts` lives in the
shared-primitive layer so both the `/connect/oauth` handlers and the MCP refresh
capability use it within the import boundaries.

### Provider logos

Operators may attach a logo per platform app (`admin_platform_oauth_app_save`
`logoBase64`; `null` clears). Uploads accept SVG, PNG, JPEG, or WebP; SVG is
sanitized and rasterized to PNG through the community-icon pipeline, so an
active image format is never stored or served. Assets live in the
`COMMUNITY_ASSETS` R2 bucket under content-hashed
`platform-oauth-app-logos/{slug}/` keys (operator-owned, like the app row);
`platform_oauth_apps.logo_key` / `logo_content_type` point at the current asset.
Serving is the public `/integrations/logos/:integrationSlug` route with
immutable caching; projections expose the relative `logoPath` and the connect
page renders it, falling back to the built-in `ProviderIcon` set.

### Admin provisioning

Operators manage platform apps through role-gated capabilities in the `admin`
domain, all audited via `auditAdminCapabilityInvocation`:

| Capability                        | Role                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `admin_platform_oauth_app_save`   | Create/update; accepts a plaintext `clientSecret`, stores it encrypted, never returns it |
| `admin_platform_oauth_app_list`   | Includes `hasClientSecret` and per-app user connection counts                            |
| `admin_platform_oauth_app_delete` | Fails while user connections reference the app — disable (`enabled = 0`) instead         |

Confidential apps require a stored client secret only while `enabled`. An agent
can therefore stage a complete provider config through `save` with
`enabled: false` and a placeholder client id; the operator pastes the real
client id and secret in `/admin/platform-integrations` and enables it. The
enable transition re-validates, so a secretless confidential app can never
become reachable.

## Where credentials live

| Field                         | Storage                                       | Notes                                      |
| ----------------------------- | --------------------------------------------- | ------------------------------------------ |
| Client id                     | `user_oauth_apps` / `platform_oauth_apps`     | Non-secret OAuth client identifier         |
| Client secret (user lane)     | Secret store                                  | Referenced by `client_secret_secret_name`  |
| Client secret (platform lane) | `platform_oauth_apps.client_secret_encrypted` | Encrypted at rest; never placeholder-named |
| Access token                  | Secret store                                  | Referenced by `access_token_secret_name`   |
| Refresh token                 | Secret store                                  | Referenced by `refresh_token_secret_name`  |

Access and refresh tokens are per-user secrets in `secret_entries` in **both**
lanes. Account export includes both per-user tables; rows contain secret _names_
and the inline `client_id`, never encrypted secret payloads. Exporting
`client_id` is deliberate: it is a non-secret OAuth client identifier, not a
credential value. `platform_oauth_apps` is global operator config and is not
part of any user's export.

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

When the user has no matching user-lane app, `?provider=<slug>` prefills from an
enabled platform app (`loadAccountIntegrationByName` in
`packages/worker/src/app/account-integrations-data.ts`). The client then skips
the client-credentials setup step entirely — no client ID/secret inputs and no
redirect-URI card. The `oauth_exchange` / `connect_oauth` JSON actions accept
`platformAppSlug`; for the platform lane every exchange input (token URL, flow,
exchange style, client id, client secret) comes from the operator-provisioned
row, never the request body, so a caller cannot point the decrypted shared
secret at an arbitrary token URL.

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
(a connection named `apps` resolves at `/account/integrations/apps`). The app
page shows provider metadata, client id, client-secret secret name (never
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

| Capability                                             | Role                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `integration_save` / `_get` / `_list` / `_delete`      | Connection CRUD with flat `clientId` output                           |
| `integration_oauth_app_list`                           | Apps with connection counts and sibling connection names              |
| `integration_oauth_app_rotate_credentials`             | Rotate shared app `clientId` / client-secret name                     |
| `integration_platform_app_list`                        | Enabled platform (built-in) apps; public projection, never any secret |
| `integration_token_refresh`                            | Host-side OAuth refresh; returns metadata only, never token values    |
| `integration_registry_search` / `integration_discover` | Untrusted integrations.sh research                                    |
| `openapi_spec_summarize` / `openapi_client_scaffold`   | Spec research helpers (bindings live in the `openapi` domain)         |

OpenAPI provider bindings (`user_openapi_bindings` /
`user_openapi_binding_operations`) are a separate primitive; see
[OpenAPI provider bindings](./openapi-bindings.md).

## Account deletion order

Deletion targets in `account-data-targets.ts` list `user_integrations` before
`user_oauth_apps` so the `ON DELETE RESTRICT` FK cannot block cleanup when
cascades are disabled. `platform_oauth_apps` is global operator config and is
not a deletion target; removing a user's connections is what releases their
`ON DELETE RESTRICT` references to it. OpenAPI binding cleanup (child operations
before parent bindings) is documented in
[OpenAPI provider bindings](./openapi-bindings.md#account-deletion-order).

## Related docs

- [Data storage](./data-storage.md) — D1 inventory and JSON shadow schemas
- [OAuth guide](../../guides/oauth.md) — agent-facing `/connect/oauth` workflow
- [Primitives map](./primitives.yaml) — `integrations` primitive and
  `integration-host-allowlist` invariant
