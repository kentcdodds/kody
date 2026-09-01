# OAuth integrations (apps and connections)

Saved third-party OAuth config is a first-class primitive: an **OAuth app**
(shared client credentials and provider endpoints) plus one or more
**connections** (connected accounts that share that app). An app lives in one of
two lanes: **user lane** — a per-user `user_oauth_apps` row the user registered
with the provider — or **platform lane** — an operator-provisioned built-in
`platform_oauth_apps` row some users still have tokens against (see
[Platform (built-in) OAuth apps](#platform-built-in-oauth-apps)). New connects
are bring-your-own only. Per-user access and refresh tokens live encrypted on
the connection (`access_token_encrypted` / `refresh_token_encrypted`). User-lane
client secrets live encrypted on the app (`client_secret_encrypted`). During
soak those values are dual-written to `secret_entries` under the `*_secret_name`
columns so placeholder resolution and reconnect still work; those names stay
hidden from `/account/secrets`, `secret_list`, and search.

Data access lives under `packages/worker/src/integrations/`. MCP capabilities
live under `packages/worker/src/mcp/capabilities/integrations/`. The hosted
connect UI is `/connect/oauth`.

## App / connection split

An **OAuth app** (`user_oauth_apps`) holds the provider client identity and
endpoint config that many connections can share:

- `client_id` (inline non-secret identifier)
- `client_secret_encrypted` (user-lane AES-GCM ciphertext; purpose
  `user-oauth-client-secret`)
- `client_secret_secret_name` (soak dual-write name, or null for public PKCE
  apps)
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
- `access_token_encrypted` / optional `refresh_token_encrypted` (AES-GCM;
  purposes `user-oauth-access-token` / `user-oauth-refresh-token`)
- `access_token_secret_name` and optional `refresh_token_secret_name` (soak
  dual-write names)
- `usage_mode` (`any` | `packages`) and `allowed_packages_json` (user-gated
  grant: `any` is execute plus every package; `packages` is only the listed
  saved package ids, and execute is denied)
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
ciphertexts stay scoped by `user_id`, so per-user isolation is unaffected.
Disconnect deletes that connection's token secrets, not a sibling connection's
shared user-lane client secret. Deleting the app removes the client secret.

## Platform (built-in) OAuth apps

`platform_oauth_apps` (migration
`packages/worker/migrations/0004-platform-oauth-apps.sql`) holds
operator-provisioned OAuth app registrations some existing connections still
refresh against. New connects and reconnects are bring-your-own only; unused
built-ins are hidden from `/connect/oauth` and `integration_platform_app_list`.
The table is global (no `user_id`) — operator config like feature flags, not
user data — so it is not a per-user-isolation exception. Rows are keyed by
`slug` and carry `provider`, `label`, the inline non-secret `client_id`,
`client_secret_encrypted`, endpoints (`token_url`, `authorize_url`,
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
accessor, and its remaining caller is host-side token refresh
(`integration_token_refresh`). `/connect/oauth` no longer decrypts or exchanges
through the shared secret. The decrypted value must never appear in capability
outputs, loader payloads, or logs. Public projections (`platform-app-shared.ts`)
expose at most a `hasClientSecret` boolean.

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
tokens on the connection (and dual-writes the secret-store names during soak),
and returns only `{ ok, refreshedAt, refreshTokenRotated }` — never token
values. Platform connections require this path — the shared client secret has no
user-facing secret name by design. User-lane connections may also refresh
through it. Ciphertext-backed refresh enforces the connection's `requiredHosts`
against the token host. The secret-store fallback (soak / pre-migration rows)
still enforces that secret's `allowed_hosts`. `integration_save` cannot add new
hosts or retarget `tokenUrl` to an unapproved host; reconnect at
`/connect/oauth` to approve a new destination. Platform-lane destinations are
operator-pinned rows, so no user-secret allowlist applies.

Reconnectable caller-errors (`IntegrationTokenRefreshCallerError`: missing
refresh token, provider HTTP 4xx / `invalid_grant`, missing secrets,
host-approval gaps, invalid connection config) best-effort dispatch
`integration.auth.failed` to the owning user's packages that declare the topic.
Successful refreshes and successful `/connect/oauth` token persists dispatch
`integration.auth.succeeded`. Every classified attempt emits; the platform does
not coalesce repeats or store working ↔ failed itself. Provider HTTP 5xx and
missing connections do not emit failed. Both payloads are metadata-first
(connection name, lane, account label, description, scopes, connect/refresh
timestamps, and for failed: reason, optional provider error fields, trusted
`reconnect_url` and `account_url`; for succeeded: `source` and trusted
`account_url`) and never include token or secret values. When `account_label` is
an email, `reconnect_url` includes `loginHint` so the provider account chooser
can preselect it. A successful Google refresh that still has no `account_label`
persists `userinfo.email` onto the connection. See
[Package subscriptions](../../guides/package-subscriptions.md).

On 401, `createAuthenticatedFetch` calls `integration_token_refresh` then
retries with a `{{secret:…}}` placeholder `Authorization` header, so raw tokens
never enter the sandbox heap. Package code that triggers refresh through
`createAuthenticatedFetch` does not need a secret-write (`allowed_packages`)
grant — the system persists rotated tokens host-side and the package never sees
or writes token values. Host-side refresh returns metadata only; there is no
raw-token helper. The integration usage grant (`any`, or `packages` that
includes that package) decides whether a package — including an unadopted
community fork — can refresh tokens. Token-exchange request building is shared:
`packages/worker/src/integrations/oauth-token-exchange.ts` lives in the
shared-primitive layer so both the `/connect/oauth` handlers and the MCP refresh
capability use it within the import boundaries.

### Provider logos

Operators may attach a logo per platform app (`admin_platform_oauth_app_save`
`logoBase64`; `null` clears). Uploads accept SVG, PNG, JPEG, or WebP. The shared
community-icon pipeline sanitizes SVG, then Cloudflare Images fits every
accepted source to a 256-pixel WebP (`fit: scale-down`, quality 90), so a newly
ingested asset is stored and served as WebP. GET paths whose stored object
predates ingest fitting (`iconFitVersion` other than `2`) rewrite the hashed key
in place; if Images fails they fall back to the original bytes so the mark still
renders. Assets live in the `COMMUNITY_ASSETS` R2 bucket under content-hashed
`platform-oauth-app-logos/{slug}/` keys (operator-owned, like the app row);
`platform_oauth_apps.logo_key` / `logo_content_type` point at the current asset.
Serving is the public `/integrations/logos/:integrationSlug` route with
immutable caching; projections expose the relative `logoPath`. The connect page
and account integration views render it, falling back to the auto-favicon, then
an operator-curated provider mark, then the letter.

User-lane OAuth apps have the same asset pipeline on `user_oauth_apps`
(`logo_key`, `logo_content_type`, `logo_source`, `favicon_source_host`).
`integration_save.logoBase64` is omit / value / `null` like the platform field.
When no explicit upload is stored, connect and account-page loads fetch the
registrable-domain favicon of `authorizeUrl` (then `apiBaseUrl` / `tokenUrl`)
over HTTPS with manual redirects, prefer `apple-touch-icon` then `rel=icon`,
accept `/favicon.ico` only when it embeds a PNG, and store a raster under
`user-oauth-app-logos/{userId}/{slug}/`. Display order is explicit upload,
auto-favicon, operator-curated provider mark, then the letter fallback. The same
`/integrations/logos/:slug` route serves user assets only to the signed-in owner
after a platform miss.

Operator-curated provider marks live in `platform_provider_marks` (slug, label,
aliases, logo). Operators add them on `/admin/provider-marks` or through
`admin_platform_provider_mark_save` / `_list` / `_delete` so a Google (or any
other) brand mark is data, not a deploy. Matching prefers an exact slug, then a
stored or built-in alias (`google-youtube-brand` → `youtube`, `nodejs` →
`nodedotjs`), then the longest family key (`github-kent` → `github`,
`x-kodykoala` → `x`), then an authorize-host token. The slug itself is a host
label (`api.github.com` matches `github`) unless the token is shorter than three
characters or a generic TLD (`com`, `app`). Host fallback prefers an exact or
suffix alias over a slug label so `mail.google.com` uses `gmail` rather than
`google`. Built-in keys and hosts live in `default-provider-mark-aliases.ts` so
a catalog row that omitted `github.com` still resolves. Saves strip those
built-ins from stored aliases; the admin editor lists them as read-only. Assets
use the same SVG/PNG/JPEG/WebP ingest pipeline under
`platform-provider-marks/{slug}/` and serve at the public
`/integrations/provider-marks/:slug` route. Login and onboarding use the inline
`ProviderIcon` set. The admin catalog page groups marks by first letter and
opens the editor inside the selected group so a multi-thousand-mark catalog does
not render every tile at once.

### Admin provisioning

Operators manage platform apps through role-gated capabilities in the `admin`
domain, all audited via `auditAdminCapabilityInvocation`:

| Capability                            | Role                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admin_platform_oauth_app_save`       | Create/update; plaintext `clientSecret` stored encrypted, never returned; optional `newSlug` renames in place (secret, logo, and user connections carry over atomically) |
| `admin_platform_oauth_app_list`       | Includes `hasClientSecret` and per-app user connection counts                                                                                                            |
| `admin_platform_oauth_app_delete`     | Fails while user connections reference the app — disable (`enabled = 0`) instead                                                                                         |
| `admin_platform_provider_mark_save`   | Create/update a brand mark (slug, label, aliases, `logoBase64`) used as the saved-integration fallback after upload/favicon                                              |
| `admin_platform_provider_mark_list`   | Lists marks with serving paths; no user data                                                                                                                             |
| `admin_platform_provider_mark_delete` | Deletes the mark row and its R2 asset                                                                                                                                    |

Confidential apps require a stored client secret only while `enabled`. An agent
can therefore stage a complete provider config through `save` with
`enabled: false` and a placeholder client id; the operator pastes the real
client id and secret in `/admin/platform-integrations` and enables it. The
enable transition re-validates, so a secretless confidential app can never
become reachable.

## Where credentials live

| Field                         | Storage                                       | Notes                                                                                   |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Client id                     | `user_oauth_apps` / `platform_oauth_apps`     | Non-secret OAuth client identifier                                                      |
| Client secret (user lane)     | `user_oauth_apps.client_secret_encrypted`     | AES-GCM; dual-written to `secret_entries` under `client_secret_secret_name` during soak |
| Client secret (platform lane) | `platform_oauth_apps.client_secret_encrypted` | Encrypted at rest; never placeholder-named                                              |
| Access token                  | `user_integrations.access_token_encrypted`    | AES-GCM; dual-written under `access_token_secret_name` during soak                      |
| Refresh token                 | `user_integrations.refresh_token_encrypted`   | AES-GCM; dual-written under `refresh_token_secret_name` during soak                     |

Access and refresh tokens are per-user ciphertext on the connection in **both**
lanes. Account export includes both per-user tables; rows contain soak secret
_names_ and the inline `client_id`, never encrypted secret payloads. Exporting
`client_id` is deliberate: it is a non-secret OAuth client identifier, not a
credential value. `platform_oauth_apps` is global operator config and is not
part of any user's export.

Connections that still have a `*_secret_name` and a null ciphertext column are
copied by `POST /__maintenance/backfill-integration-credentials` (see
[Secret rotation](../secret-rotation.md#backfilling-integration-owned-credentials)).

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
session, writes access/refresh tokens on the connection (and dual-writes the
soak secret-store names), and upserts the app + connection via the integrations
service. A signed-in visit with no `provider` renders a chooser of saved
connections that can start from a name alone. Unused platform (built-in) apps do
not appear. Existing platform connections stay listed so their tokens can keep
refreshing, but reconnect is always bring-your-own: `?provider=<name>` prefills
endpoints and scopes and asks for the user's own client credentials. `platform=`
query flags and `platformAppSlug` on `oauth_exchange` / `connect_oauth` are
rejected. Reconnect with `?provider=<integration-name>` reuses saved authorize
metadata (scopes, `scopeSeparator`, `extraAuthorizeParams`) from a user-lane
app.

The hosted page leads with the provider mark, credentials or a connect button, a
terms note, and a **Change scopes** disclosure. Endpoints, host allowlists, and
stored config stay behind an advanced disclosure. A `?provider=` visit that
cannot resolve authorize and token URLs offers a copy-prompt for an agent.

`createAuthenticatedFetch(providerName)` (execute runtime helper) loads the
named connection joined to its app, refreshes the access token when needed, and
returns a fetch wrapper that:

1. asserts the request host against the connection allowlist
2. attaches the bearer token only after that check passes

Capability and search detail surfaces keep a **flat connection-shaped** config
(`clientId`, endpoints, `authorization`, `requiredHosts`) so callers do not need
to join app and connection themselves. Search does not list soak token secret
names.

## Account UI

`/account/integrations` is a list of integrations (the services you connect:
Google, GitHub). Selecting a row shows that integration and the connections
(signed-in accounts) on it. Each connection shows how many scopes it requests
versus the built-in menu when one exists, and a copy-prompt asks an agent to
widen the integration's reconnect scopes (then ask the user to reconnect).
Existing built-in connections show a small “Provided by Kody” indicator.
Reconnect and add-account links go to bring-your-own `/connect/oauth` (no
`platform=`). Deep links to a connection (`/account/integrations/:name`) open
the parent integration and highlight that connection. User-registered
integrations also have `/account/integrations/apps/:appSlug` (a connection named
`apps` resolves at `/account/integrations/apps`). Endpoints, secret names, host
allowlists, flow / PKCE / exchange style, and credential rotation stay behind an
advanced disclosure. Each connection also shows a usage grant: **any context**
(execute and every package) or **specific packages** only. Agents tighten that
grant with `integration_lock` (switch to packages mode and add a saved package
id; unlocking or removing a grant is website-only). One-click approval lives at
`/account/integrations/approve?name=&package_id=`; approving a package while the
connection is still `any` leaves it `any` so execute stays usable. The rotate
form posts to `/account/integrations.json` with
`action: "rotate_oauth_app_credentials"`: it stores a new client-secret value on
the app (and dual-writes the secret store during soak), then calls
`rotateOauthAppClientCredentials` so every sibling connection picks up the new
client id / secret name on the next join. Each connection has a double-checked
Disconnect control; user-registered integrations also have Delete integration.
Both are delayed-commit undoable actions (`createUndoableAction`): the UI
updates immediately, and `/account/integrations.json` receives
`disconnect_connection` or `delete_oauth_app` only after the undo window (or
when the user leaves). Built-in apps cannot be deleted; disconnect their
connections instead.

## Capability surface

Domain: `integrations`
(`packages/worker/src/mcp/capabilities/integrations/domain.ts`).

| Capability                                        | Role                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `integration_save` / `_get` / `_list` / `_delete` | Connection CRUD with flat `clientId` output                                       |
| `integration_lock`                                | Tighten-only usage lock: packages mode + add a package id; unlock is website-only |
| `integration_oauth_app_list`                      | Apps with connection counts and sibling connection names                          |
| `integration_oauth_app_delete`                    | Delete a user-lane app and every connection on it                                 |
| `integration_oauth_app_rotate_credentials`        | Rotate shared app `clientId` / client-secret name                                 |
| `integration_platform_app_list`                   | Always empty while platform apps are retired; operators use admin list            |
| `integration_token_refresh`                       | Host-side OAuth refresh; returns metadata only, never token values                |

## Account deletion order

Deletion targets in `account-data-targets.ts` list `user_integrations` before
`user_oauth_apps` so the `ON DELETE RESTRICT` FK cannot block cleanup when
cascades are disabled. `platform_oauth_apps` is global operator config and is
not a deletion target; removing a user's connections is what releases their
`ON DELETE RESTRICT` references to it.

## Related docs

- [Data storage](./data-storage.md) — D1 inventory and JSON shadow schemas
- [OAuth guide](../../guides/oauth.md) — agent-facing `/connect/oauth` workflow
- [Primitives map](./primitives.yaml) — `integrations` primitive and
  `integration-host-allowlist` invariant
