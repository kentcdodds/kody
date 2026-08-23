# Connect your agent

Kody is an MCP server. You use it from Cursor, ChatGPT, Codex, Claude Desktop,
Grok, Claude Code, OpenCode, GitHub Copilot (VS Code or CLI), the GitHub Copilot
app, or any other AI agent that supports MCP — not from a separate Kody chat
app.

Agents discovering this host can read `/auth.md` for the OAuth registration
block and MCP URL, and `/.well-known/mcp/server-card.json` for the server card.
People following a host-specific walkthrough can stay on this page or use Get
started (`/onboarding`).

The in-app Get started page (`/onboarding`) has tabs with client-specific
instructions. Step 1 shows a copyable Automatic install command first.
Deeplinks, the MCP URL, and JSON/TOML merge stay under Manual.

## Add the MCP server

1. Open Get started (`/onboarding`) and choose your client tab, or follow the
   short notes below.
2. Run the Automatic install command for your client. It already includes this
   deployment’s MCP URL (`https://<this-host>/mcp`). Hosts without a CLI copy
   that URL instead.
3. Complete the OAuth flow when the host opens it. Sign in to Kody if needed,
   then approve access.

Your account email must be verified before authorize can finish or MCP can run.
If authorize asks you to verify, keep that tab open, finish verification (from
the email link or `/pending-verification`), then continue. You do not need to
restart the host connection. Unverified visits to Get started (`/onboarding`)
redirect to `/pending-verification`; after verification, onboarding shows the
MCP URL and setup prompt.

### Client notes

- **Cursor** — Run the Automatic Node command to merge `mcpServers.kody.url`
  into `~/.cursor/mcp.json` without replacing other servers, then Authenticate
  in the Cursor MCP list. Manual includes Add to Cursor, the MCP URL, and JSON
  merge for `~/.cursor/mcp.json` / `.cursor/mcp.json`.
- **Claude Desktop** — Copy the MCP URL into Settings → Connectors (custom
  connector). Remote servers are not configured through
  `claude_desktop_config.json`. After connecting, start a new chat and ask
  Claude to list Kody tools before the first task — Claude Desktop often does
  not bind MCP tools until that next turn.
- **Grok** — On [grok.com/connectors](https://grok.com/connectors), click **New
  Connector**, select **Custom**, and paste the MCP URL. Complete OAuth when
  prompted. For Grok Business and Enterprise, a team admin must first add this
  custom MCP server in the cloud console; members can then connect it from the
  Grok connectors page. See xAI's
  [custom MCP connector docs](https://docs.x.ai/grok/connectors).
- **Claude Code** — `claude mcp add --transport http -s user kody <url>`, or a
  `.mcp.json` entry with `"type": "http"`.
- **ChatGPT** — On an
  [eligible paid plan (Plus, Pro, Business, Enterprise, or Education)](https://developers.openai.com/api/docs/guides/developer-mode),
  turn on Developer mode on the web (Settings → Security and login), then create
  an app under Settings → Plugins → Browse plugins → Create app with the MCP
  URL. In a managed workspace, ask an admin to enable access if the setting or
  Plugins UI is missing. You can use the site favicon (`/apple-touch-icon.png`)
  for the app icon; the owner can edit a developer-mode app's name and logo
  later from Manage in Apps settings.
- **Codex** — `codex mcp add kody --url <url>`, then `codex mcp login kody` if
  OAuth does not start. Manual includes the shared `~/.codex/config.toml`
  `[mcp_servers.kody]` `url` entry.
- **OpenCode** — `opencode mcp add kody --url <url>`, then
  `opencode mcp auth kody` if prompted. Manual includes a `mcp.kody` remote
  entry in `opencode.json` (`"type": "remote"`).
- **Copilot** — In Copilot CLI, run
  `copilot mcp add --transport http kody <url>`. In VS Code Copilot Chat, use
  Add to VS Code or `.vscode/mcp.json` with root key `servers` (not
  `mcpServers`) and `"type": "http"`, then Agent mode. You can also merge a
  `mcpServers` entry into `~/.copilot/mcp-config.json` (CLI does not read
  `.vscode/mcp.json`).
- **Copilot App** — In the GitHub Copilot app, open settings → **MCP Servers**
  and add a custom remote HTTP server with the MCP URL. Servers from Copilot CLI
  or repository MCP config are also available in the app.
- **Open WebUI** — Add an MCP Streamable HTTP connection to this deployment’s
  MCP URL and use **OAuth 2.1** (dynamic registration) first. Enabling the tool
  in a chat must open the Kody authorize window. If that window never opens on
  one browser or device, retry from another. Hosts that need a pre-registered
  confidential client can use **OAuth 2.1 (Static)** with a client minted at
  Account → Advanced → MCP OAuth clients. Register the exact Open WebUI callback
  (`{open-webui}/oauth/clients/mcp:{connection-id}/callback`) and set OAuth
  Server URL to this deployment’s origin when discovery from the MCP URL is not
  enough.

### Coding vs non-coding agents

Using Kody packages works great with non-coding agents such as Claude Desktop,
ChatGPT, Grok, and the GitHub Copilot app. For creating or editing packages, a
coding agent (Cursor, Claude Code, Codex, Copilot, OpenCode, and similar) is
usually smoother because those hosts can edit files and iterate on code more
easily.

## Connect Notion or Linear, then persist a first build

After the connection works, Get started Step 2 offers Notion and Linear as
remote MCP servers (`https://mcp.notion.com/mcp` and
`https://mcp.linear.app/mcp`). Connect one and authorize it, or skip.

Step 3 copies a prompt that asks your agent to run one ad hoc request, then
persist that working code as a package you own. Built-in platform OAuth and
featured starters stay under Advanced. If nothing fits, use **Choose your own
adventure** to copy an open-ended setup prompt.

## Where to go next

- [First steps](./first-steps.md) — search-first habits and common goals
- [Troubleshooting](./troubleshooting.md) — auth, empty results, and approvals
