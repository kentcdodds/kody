# Connect remote MCP servers to Kody

Kody can act as an **MCP client**: you add a remote MCP server, and its tools
become callable as `kody.mcp["server-name"].tool_name(...)`.

This is the inverse of [connecting your agent to Kody](./connect-your-agent.md)
(where Kody is the MCP _server_).

## Add a server

1. Open [`/account/mcp-servers`](https://heykody.app/account/mcp-servers), or
   ask your agent to use `mcp_server_add` with a short kebab-case `name` and the
   server `url` (https required).
2. If the server needs OAuth, Kody returns an authorization link. Open it, sign
   in at the provider, and approve access.
3. Confirm with `mcp_server_list` (or refresh the account page). Connected tools
   show up in `search` under a `mcp:<name>` domain.

## OAuth allowlists (common failure)

When Kody connects, it registers as an OAuth client using:

- **Client origin:** the deployment's canonical app origin (for hosted Kody,
  `https://heykody.app`)
- **Redirect URI:** `{origin}/account/mcp-servers/oauth/callback`

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

## Related

- [Architecture: MCP client servers](../contributing/architecture/mcp-client-servers.md)
- [Troubleshooting](./troubleshooting.md)
