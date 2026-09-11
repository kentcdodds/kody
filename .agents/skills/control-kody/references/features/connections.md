# Connections

Inbound MCP hosts (connected agents): the MCP URL to paste into another agent,
per-host setup guide links, the grouped list of hosts that already authorized,
and per-`clientId` revoke. Also links the Advanced MCP OAuth clients page.

## How to get there

`/account/connections` (account rail → Connections; Overview keeps a "Manage
connections" link). Setup guides link to `/onboarding`, which resumes at the
right wizard step for the account.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/connected-agents.json
```

## APIs

- `GET|POST /account/connected-agents.json` (`{ intent: 'revoke', clientId }`)
- `mcpServerUrl` in that payload is empty until the account email is verified
  (same gate as `/onboarding.json`); the page then shows a verify note instead
  of the copy card.

## Gotchas

- Seed users start with no connected agents; connect one from onboarding or an
  MCP host to see the list. Revoke is a double-check button.
- Hosts are grouped by display name (logos for known kinds, newest-first,
  best-effort labels). That list is not `users.mcp_client_name` and not minted
  MCP OAuth clients (`/account/mcp-oauth-clients`).
- `/account/connections.json` is the sign-in provider (GitHub, Google, …) list
  on Overview, not this page's data.
