# Connect your agent

Kody is an MCP server. You use it from Cursor, ChatGPT, Codex, Claude Desktop,
Grok.com, Grok CLI, Claude Code, OpenCode, GitHub Copilot (VS Code or CLI), the
GitHub Copilot app, or any other AI agent that supports MCP — not from a
separate Kody chat app.

Agents discovering this host can read `/auth.md` for the OAuth registration
block and MCP URL, and `/.well-known/mcp/server-card.json` for the server card.
People following a host-specific walkthrough can stay on this page or use Get
started (`/onboarding`).

The in-app Get started page (`/onboarding`) shows one Automatic command first:
`npx @kodycodes/cli install`. That CLI detects running local agents and writes
each host's remote MCP entry for this deployment. Host-specific deeplinks,
vendor CLIs, the MCP URL, and JSON/TOML merge stay under Manual. A second client
is worth it when you want the same [memories](./memory.md) and packages from
another agent — you do not need every Manual tab.

## Add the MCP server

1. Open Get started (`/onboarding`).
2. Copy and run the Automatic command. On [kody.codes](https://kody.codes) that
   is `npx @kodycodes/cli install` (the CLI default MCP URL is
   `https://kody.codes/mcp`). Preview and local origins add `--mcp-url` with
   that deployment's MCP URL (`https://<this-host>/mcp`).
3. Complete the OAuth flow when the host opens it. Sign in to Kody if needed,
   then approve access.

The CLI configures local agents it finds (Cursor, Claude Desktop, VS Code,
Claude Code, Codex, and similar). It does not configure web hosts such as
ChatGPT, Claude.ai, or Grok — those stay under Manual.

Your account email must be verified before authorize can finish or MCP can run.
If authorize asks you to verify, keep that tab open, finish verification (from
the email link or `/pending-verification`), then continue. You do not need to
restart the host connection. Unverified visits to Get started (`/onboarding`)
redirect to `/pending-verification`; after verification, onboarding shows the
MCP URL and setup prompt.

### Client notes

Manual on Get started has one tab per host. Use those when you are not running
`@kodycodes/cli`, or when the host is web-only.

- **Cursor** — After the CLI writes `~/.cursor/mcp.json`, Authenticate in the
  Cursor MCP list. Manual includes Add to Cursor, the MCP URL, and JSON merge
  for `~/.cursor/mcp.json` / `.cursor/mcp.json`.
- **Claude Desktop** — Copy the MCP URL into Settings → Connectors (custom
  connector). Remote servers are not configured through
  `claude_desktop_config.json`. After connecting, start a new chat and ask
  Claude to list Kody tools before the first task — Claude Desktop often does
  not bind MCP tools until that next turn.
- **Grok.com** — On [grok.com/connectors](https://grok.com/connectors), click
  **New Connector**, select **Custom**, and paste the MCP URL. Complete OAuth
  when prompted. For Grok Business and Enterprise, a team admin must first add
  this custom MCP server in the cloud console; members can then connect it from
  the Grok connectors page. See xAI's
  [custom MCP connector docs](https://docs.x.ai/grok/connectors).
- **Grok CLI** — `grok mcp add --transport http --scope user kody <url>`. That
  writes `~/.grok/config.toml`. OAuth opens a browser on first use; in the TUI,
  `/mcps` then `i` authenticates. `grok mcp doctor kody` checks the connection.
  See xAI's [Grok CLI MCP docs](https://docs.x.ai/build/features/mcp-servers).
- **Claude Code** — After the CLI writes the remote entry, enter `/mcp` → Kody →
  Authenticate. Manual includes
  `claude mcp add --transport http -s user kody <url>`, or a `.mcp.json` entry
  with `"type": "http"`.
- **ChatGPT** — On an
  [eligible paid plan (Plus, Pro, Business, Enterprise, or Education)](https://developers.openai.com/api/docs/guides/developer-mode),
  turn on Developer mode on the web (Settings → Security and login), then create
  an app under Settings → Plugins → Browse plugins → Create app with the MCP
  URL. In a managed workspace, ask an admin to enable access if the setting or
  Plugins UI is missing. You can use the site favicon (`/apple-touch-icon.png`)
  for the app icon; the owner can edit a developer-mode app's name and logo
  later from Manage in Apps settings.
- **Codex** — After the CLI writes the shared config, run `codex mcp login kody`
  if OAuth does not start. Manual includes `codex mcp add kody --url <url>` and
  the shared `~/.codex/config.toml` `[mcp_servers.kody]` `url` entry.
- **OpenCode** — After the CLI writes the remote entry, run
  `opencode mcp auth kody` if prompted. Manual includes
  `opencode mcp add kody --url <url>` and a `mcp.kody` remote entry in
  `opencode.json` (`"type": "remote"`).
- **Copilot** — After the CLI writes the remote entry, complete OAuth in that
  host. Manual includes `copilot mcp add --transport http kody <url>`. In VS
  Code Copilot Chat, use Add to VS Code or `.vscode/mcp.json` with root key
  `servers` (not `mcpServers`) and `"type": "http"`, then Agent mode. You can
  also merge a `mcpServers` entry into `~/.copilot/mcp-config.json` (CLI does
  not read `.vscode/mcp.json`).
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
ChatGPT, Grok.com, and the GitHub Copilot app. For creating or editing packages,
a coding agent (Cursor, Claude Code, Codex, Grok CLI, Copilot, OpenCode, and
similar) is usually smoother because those hosts can edit files and iterate on
code more easily.

## Connect a workspace MCP, then persist a first build

After the connection works, Get started Step 2 offers official remote MCP
servers for Notion, Linear, Atlassian, Stripe, Sentry, and Canva, plus the
matching `@kody/*-mcp` helper. You can also add a custom MCP URL, try a
zero-auth example, or skip. MCP is the quicker first-value path. Prefer the
official non-MCP API packages (`@kody/notion`, `@kody/linear`, `@kody/jira`,
`@kody/stripe`, `@kody/sentry`, `@kody/canva`) for reusable integrations — do
not convert them to MCP-first.

Step 3 copies a prompt that asks your agent to run one ad hoc request, then
persist that working code as a package you own. Built-in platform OAuth and
featured starters stay under Advanced. If nothing fits, use **Choose your own
adventure** to copy an open-ended setup prompt.

## Where to go next

- [First steps](./first-steps.md) — search-first habits and common goals
- [Troubleshooting](./troubleshooting.md) — auth, empty results, and approvals
