# Connections

Inbound MCP hosts (connected agents). The connected list is a grouped panel with
per-`clientId` revoke. **Add connection** is its own page: the full client wall
from onboarding Step 1 — every named agent, on every device, none folded under
Not listed — then one host's install steps. The MCP URL card covers any other
host that speaks MCP. Also links the Advanced MCP OAuth clients page.

Experimenters (`connection-profiles` flag, audience `experiments_opt_in`) also
see named connection profiles on the list page: create a profile, add packages
through the **Add package** combobox (each granted package is one row with
read/execute toggles and Remove), copy `?profile=` MCP URL, and **Edit
packages** on an existing profile (saves via `intent: 'update'`; the name is not
editable there). Only granted packages render as rows, so large accounts do not
get one checkbox per package. Unlimited remains the default connection (no
profile param).

## How to get there

Canonical pages are `/@<slug>/-/connections` (and `/@<slug>/-/connections/new`,
`/@<slug>/-/connections/new/:agent`).

- `/@<slug>/-/connections` — connected list, Add connection button, MCP URL.
  Does not nest the add grid. Profiles (when flagged) sit under Unlimited.
- `/@<slug>/-/connections/new` — the agent grid, with a “← back to connections”
  link. Does not wrap the connected list.
- `/@<slug>/-/connections/new/:agent` — install steps for one `McpClientKind`
  (`cursor`, `claude-code`, `chatgpt`, …; `other` is not a page here). Unknown
  agents 404.

Account rail → Connections; Overview keeps a "Manage connections" link.

Each org page lists only the signed-in person's agents approved for that org
(the org picked on the MCP consent screen; grants from before org stamping
belong to the signup org). Team orgs open it to every member role and to
grant-only collaborators. Revoke there removes only that org's grants; the same
host stays connected elsewhere. Connection profiles are signup-org only.
`/account/connected-agents.json` binds the org from a same-origin Referer on
`/@<slug>/-/connections`.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/connected-agents.json
node tools/control-kody.ts request GET /@<slug>/-/connections/new
node tools/control-kody.ts request GET /@<slug>/-/connections/new/cursor
# Create a profile (experimenter + flag on):
node tools/control-kody.ts request POST /account/connected-agents.json --json '{"intent":"create","name":"ci","grants":[{"resourceType":"package","resourceId":"<package-id>","actions":["read","execute"]}]}'
```

## APIs

- `GET|POST /account/connected-agents.json` (`{ intent: 'revoke', clientId }` or
  profile `{ intent: 'create'|'update'|'delete', ... }`)
- `mcpServerUrl` in that payload is empty until the account email is verified
  (same gate as `/onboarding.json`); the page then shows a verify note instead
  of the grid and copy card.
- When `connectionProfilesEnabled` is true, the payload also includes
  `connectionProfiles` and `connectionProfilePackageOptions`.
- All three HTML views share that one payload (no refetch between them).

## Gotchas

- Seed users start with no connected agents; connect one from Add connection or
  an MCP host to see the list. Revoke is a double-check button per connection:
  confirm and the in-flight POST stay on that row, so other Revoke controls stay
  clickable. Confirm removes the row immediately; a failed request restores that
  row only.
- Hosts are grouped by display name (logos for known kinds, last-used then
  connected newest-first, best-effort labels). Last used is the revoke signal
  (successful `/mcp` bearer validation). A missing stamp renders as "unknown".
  Connected is grant `createdAt`. That list is not `users.mcp_client_name` and
  not minted MCP OAuth clients (`/account/mcp-oauth-clients`).
- The grid reuses onboarding's `AgentPickerGrid` with `viewport: 'both'` on
  every entry. Every named agent shows on phone and desktop. Already-connected
  hosts keep a Connected mark and stay selectable (same as onboarding Step 3) so
  connect steps can be re-viewed. The connected list offers **View connect
  steps** for known kinds.
- `/account/connections.json` is the sign-in provider (GitHub, Google, …) list
  on Overview, not this page's data.
- Profile names are at most 64 characters; `Unlimited` is reserved. Empty named
  profiles deny all packages; absent profile keeps unlimited access. Non-
  experimenters ignore `?profile=`.
