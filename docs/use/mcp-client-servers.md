# Connect remote MCP servers to Kody

Kody can act as an **MCP client**: you add a remote MCP server, and its tools
become callable as `kody.mcp["server-name"].tool_name(...)`.

This is the inverse of [connecting your agent to Kody](./connect-your-agent.md)
(where Kody is the MCP _server_).

## Add a server

1. Open [`/account/mcp-servers`](https://kody.codes/account/mcp-servers), or ask
   your agent to use `mcp_server_add` with a short kebab-case `name` and the
   server `url` (https required).
2. If the server authenticates with a static bearer token (or other
   Authorization scheme), paste it in the optional Bearer token field — or pass
   `bearerToken` to `mcp_server_add`. Bare tokens are sent as
   `Authorization: Bearer <token>`; scheme-prefixed values and full
   `Authorization: …` header pastes are normalized. The credential is stored
   only in your private MCP client hub and is never returned later.
3. If the server needs OAuth, Kody returns an authorization link. Open it, sign
   in at the provider, and approve access.
4. Confirm with `mcp_server_list` (or refresh the account page). Connected tools
   show up in `search` under a `mcp:<name>` domain.

## OAuth allowlists (common failure)

When Kody connects, it identifies itself as an OAuth client using:

- **Client origin:** the deployment's canonical app origin (for hosted Kody,
  `https://kody.codes`)
- **Redirect URI:** `{origin}/account/mcp-servers/oauth/callback`
- **Client ID Metadata Document (HTTPS only):**
  `{origin}/oauth/client-metadata.json`

On HTTPS deployments, Kody presents that CIMD URL as `client_id` when the remote
authorization server advertises `client_id_metadata_document_supported`.
Otherwise it falls back to Dynamic Client Registration. Local `http` origins
skip CIMD and use DCR only.

Many authorization servers (including FusionAuth "authorized origins" / redirect
URI settings, and other providers with similar allowlists) reject the authorize
step unless those values are permitted.

If authorization fails with a message like `Invalid origin uri https://…` or an
invalid redirect URI error:

1. In the remote MCP server's identity provider, allow Kody's client origin and
   register the exact redirect URI shown on `/account/mcp-servers` (also
   returned as `oauthClientOrigin` / `oauthCallbackUrl` from `mcp_server_add`
   and `mcp_server_list`).
2. Remove and re-add the server in Kody (or reconnect) so client registration
   picks up the allowlisted values.
3. Authorize again.

Kody itself does not maintain a per-provider allowlist for this flow — the
remote authorization server does.

Servers that do not use OAuth connect immediately and do not need these steps.
Bearer-token servers also skip OAuth when the static Authorization header is
enough for the remote server.

## Home automation

Household LAN tools (lights, TVs, thermostats, and the rest of the home process)
are a normal outbound MCP server at a tunneled HTTPS URL such as
`https://home.example.com/mcp` (Cloudflare tunnel; Access bypasses `/mcp` and
the OAuth machine paths). Add it as `home`, pass Cloudflare Access on
`/authorize`, and approve. The LAN origin is trusted and has no extra login.
Then call `kody.mcp["home"].tool_name(...)`.

## Related

- [Architecture: MCP client servers](../contributing/architecture/mcp-client-servers.md)
- [Troubleshooting](./troubleshooting.md)
