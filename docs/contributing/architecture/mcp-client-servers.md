# MCP client servers (user-added MCP servers)

Kody can act as an **MCP client** to remote MCP servers a user adds. Tools
discovered on those servers become synthesized capability domains callable from
execute via `kody.mcp["<server-name>"].<tool>(input)`. This is the inverse of
the `/mcp` endpoint (where Kody is the server) and complements remote connectors
(which dial in to Kody over WebSockets): MCP client servers are **remote-only**
— Kody dials out over HTTP using the Agents SDK `MCPClientManager`.

## Components

- **`McpClientHub` Durable Object** (`packages/worker/src/mcp-client/hub.ts`) —
  one per user, id derived from the stable MCP `userId`. Owns the Agents SDK
  `MCPClientManager`, which persists registered servers, OAuth client
  registrations, and tokens in the DO's SQLite storage. Exposes RPC methods:
  `addServer`, `reconnectServer`, `refreshServer`, `removeServer`,
  `handleOAuthCallback`, `getSnapshot`, `callTool`, and
  `purgeForAccountDeletion`.
- **D1 `mcp_server_settings` table**
  (`packages/worker/migrations/0053-mcp-server-settings.sql`) — user-scoped
  metadata (id, name, url, enabled). D1 answers "which servers does this user
  have enabled" without waking the DO; the DO owns live connection state and
  tokens.
- **Hub client with snapshot cache**
  (`packages/worker/src/mcp-client/hub-client.ts`) — worker-side facade over the
  DO stub. Snapshots are cached per user for 30 seconds and invalidated on every
  mutation.
- **Settings service** (`packages/worker/src/mcp-client/settings-service.ts`) —
  validates names (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`) and URLs (https
  required; plain http allowed only for loopback hosts), and keeps D1 and the
  hub DO in sync. Optional `bearerToken` values are normalized into an
  `Authorization` header and stored only in the hub DO's Agents SDK
  `server_options` (never in D1 or list/detail API responses).

## OAuth flow

1. `addServer` registers the server with a callback URL of
   `<canonical-app-origin>/account/mcp-servers/oauth/callback` (from
   `APP_BASE_URL`, not the request host) and starts connecting. Optional static
   Authorization headers from `bearerToken` are registered on the transport at
   the same time.
2. If the server requires OAuth, the SDK performs dynamic client registration
   and the connection parks in state `authenticating` with an `authUrl`.
3. The user opens `authUrl` in the browser (surfaced in the account UI and by
   the `mcp_server_add` / `mcp_server_list` capabilities). The authorize link
   uses `rel="noopener noreferrer"` so browser Referer does not send Kody's
   origin to providers that enforce authorized-origin allowlists on Referer.
4. The provider redirects back to the callback route. The worker authenticates
   the browser session cookie, forwards the full callback URL to that user's hub
   DO, and the SDK exchanges the code (matching the `state` parameter to the
   pending authorization) and establishes the connection.
5. The hub only treats the callback as successful when the connection reaches
   `ready`. If the Agents SDK reports `authSuccess` but the connection stays in
   `authenticating` (including the stuck case with no stored auth URL after the
   SDK clears it), the route redirects with `auth=error` and a concrete reason.
   Origin and redirect-URI rejection messages are enriched with Kody's
   `oauthClientOrigin` and `oauthCallbackUrl`. Reconnect also recovers that
   stuck state by invalidating unusable tokens and requesting a fresh
   authorization URL.
6. The route redirects to `/account/mcp-servers/:serverId?auth=success|error`
   when the callback resolves to a server (including failures), or
   `/account/mcp-servers?auth=error` when it does not, for user feedback. Tokens
   live only in the DO storage; they never reach D1 or the client.

Because the callback is resolved through the session cookie, the OAuth state is
always looked up in the hub belonging to the signed-in user — cross-user
callback replay finds no matching state.

Providers that allowlist client origins or redirect URIs must permit the
canonical app origin and the callback path above. See
[Connect remote MCP servers](../../use/mcp-client-servers.md).

## Capability synthesis and invocation

- Registry: `getCapabilityRegistryForContext` loads enabled server refs from D1
  and hub snapshots, then `synthesizeMcpServerToolDomain`
  (`packages/worker/src/mcp/capabilities/mcp-server/index.ts`) creates a
  `mcp:<server-name>` domain with a capability per discovered tool
  (`mcp:<server-name>:<tool>`), marked `source: 'mcp-server'`.
- Execute: the `kody.mcp` proxy mirrors `kody.remote` — tools are called as
  `kody.mcp["<server-name>"].<tool>(input)` and are never exposed as flat
  `kody.*` functions. Search capability detail returns the exact accessor.
- Tool calls flow worker → hub DO `callTool` → `MCPClientManager.callTool` →
  remote server. At the synthesized capability boundary, results are wrapped
  with explicit `__mcpContent` / companion markers when protocol content must
  reach the upstream client (especially non-text blocks such as images).
  Structured content remains available for code; `isError` is preserved. See
  [Raw MCP content blocks](../../use/raw-content-blocks.md).
- Malformed third-party content blocks are rejected with a source-specific
  error. Image/audio URL-only payloads are not fetched.

## Management surfaces

- **UI**: `/account/mcp-servers` (add with optional bearer token, authorize,
  reconnect, refresh tools, enable/disable, remove; shows live state and
  discovered tools).
- **Capabilities**: the `mcp_servers` domain (`mcp_server_add`,
  `mcp_server_list`, `mcp_server_reconnect`, `mcp_server_refresh`,
  `mcp_server_remove`, `mcp_server_set_enabled`). `mcp_server_add` accepts
  optional `bearerToken`.

## Isolation and lifecycle

- Every path is scoped by `userId`: D1 rows, the hub DO id, and registry
  synthesis. Account deletion purges the hub DO storage
  (`purgeForAccountDeletion`) and deletes `mcp_server_settings` rows; account
  export includes the settings rows.

## Related docs

- [Remote connectors](./remote-connectors.md) — the inbound-WebSocket
  counterpart with the same naming pattern (`kody.remote[...]`).
- [Data storage](./data-storage.md) — D1 vs Durable Object storage split.
