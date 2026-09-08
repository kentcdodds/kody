# MCP servers

User-added MCP servers and the OAuth clients they mint.

## How to get there

`/account/mcp-servers` → `/account/mcp-servers/new` →
`/account/mcp-servers/:serverId`. Clients: `/account/mcp-oauth-clients`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/mcp-servers.json
node tools/control-kody.ts request GET /account/mcp-oauth-clients.json
```

## APIs

- `GET|POST /account/mcp-servers.json`
- `GET|POST /account/mcp-oauth-clients.json`
- `/account/mcp-servers/oauth/callback`

## Gotchas

- App `/mcp` (Kody-as-server) is a different surface. Unauthenticated GET is 401
  by design.
- After IdP success, Status on `/account/mcp-servers/:serverId` shows a
  sanitized last settle error when tool discovery does not finish (including
  after a 2025 handshake retry). Reconnect from that page.
