# Connect your agent

Kody is an MCP server. You use it from Cursor, ChatGPT, Codex, Claude Desktop,
Grok, Claude Code, OpenCode, VS Code, or any other AI agent that supports MCP —
not from a separate Kody chat app.

The in-app Get started page (`/onboarding`) has tabs with client-specific
instructions and copyable config snippets for the host you are on.

## Add the MCP server

1. Open Get started (`/onboarding`) and choose your client tab, or follow the
   short notes below.
2. Use this deployment’s MCP URL: `https://<this-host>/mcp`.
3. Complete the OAuth flow when the host opens it. Sign in to Kody if needed,
   then approve access.

Your account email must be verified before authorize can finish or MCP can run.
If authorize asks you to verify, keep that tab open, finish verification (from
the email link or `/pending-verification`), then continue. You do not need to
restart the host connection. Unverified visits to Get started (`/onboarding`)
redirect to `/pending-verification`; after verification, onboarding shows the
MCP URL and setup prompt.

### Client notes

- **Cursor** — Add a remote MCP server from Customize, or merge a
  `mcpServers.kody.url` entry into `~/.cursor/mcp.json` / `.cursor/mcp.json`.
- **Claude Desktop** — Use Settings → Connectors (custom connector + MCP URL).
  Remote servers are not configured through `claude_desktop_config.json`.
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
- **Codex** — Codex (ChatGPT desktop, CLI, IDE) shares `~/.codex/config.toml`
  with an `[mcp_servers.kody]` `url` entry.
- **OpenCode** — Add a `mcp.kody` remote entry in `opencode.json`
  (`"type": "remote"`).
- **VS Code** — Use `.vscode/mcp.json` with root key `servers` (not
  `mcpServers`) and `"type": "http"`.

### Coding vs non-coding agents

Using Kody packages works great with non-coding agents such as Claude Desktop,
ChatGPT, and Grok. For creating or editing packages, a coding agent (Cursor,
Claude Code, Codex, VS Code, OpenCode, and similar) is usually smoother because
those hosts can edit files and iterate on code more easily.

## Install a starter or build your own

After the connection works, the Get started page offers admin-reviewed starter
packages for one-click install. Each card can copy a short agent prompt for
remaining setup. Prefer a starter when one is close to what you want.

If nothing fits, use **Choose your own adventure** on that page to copy a prompt
that asks your agent what Kody can do and helps you connect an integration and
build something custom.

## Where to go next

- [First steps](./first-steps.md) — search-first habits and common goals
- [Troubleshooting](./troubleshooting.md) — auth, empty results, and approvals
