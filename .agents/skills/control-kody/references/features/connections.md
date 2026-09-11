# Connections

Inbound MCP hosts (connected agents). The connected list is the same grouped
panel with per-`clientId` revoke that Overview used to host. **Add connection**
opens the full client wall from onboarding Step 1 — every named agent, on every
device, none folded under Not listed — then one host's install steps. The MCP
URL card covers any other host that speaks MCP. Also links the Advanced MCP
OAuth clients page.

## How to get there

- `/account/connections` — connected list, Add connection button, MCP URL.
- `/account/connections/new` — the agent grid.
- `/account/connections/new/:agent` — install steps for one `McpClientKind`
  (`cursor`, `claude-code`, `chatgpt`, …; `other` is not a page here). Unknown
  agents 404.

Account rail → Connections; Overview keeps a "Manage connections" link.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/connected-agents.json
node tools/control-kody.ts request GET /account/connections/new
node tools/control-kody.ts request GET /account/connections/new/cursor
```

## APIs

- `GET|POST /account/connected-agents.json` (`{ intent: 'revoke', clientId }`)
- `mcpServerUrl` in that payload is empty until the account email is verified
  (same gate as `/onboarding.json`); the page then shows a verify note instead
  of the grid and copy card.
- All three HTML views share that one payload (no refetch between them).

## Gotchas

- Seed users start with no connected agents; connect one from Add connection or
  an MCP host to see the list. Revoke is a double-check button.
- Hosts are grouped by display name (logos for known kinds, newest-first,
  best-effort labels). That list is not `users.mcp_client_name` and not minted
  MCP OAuth clients (`/account/mcp-oauth-clients`).
- The grid reuses onboarding's `AgentPickerGrid` with `viewport: 'both'` on
  every entry, so the phone/desktop split and greyed same-ecosystem cards that
  onboarding applies do not appear here.
- `/account/connections.json` is the sign-in provider (GitHub, Google, …) list
  on Overview, not this page's data.
