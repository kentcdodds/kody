# Connect your agent

Kody is an MCP server. You use it from Cursor, Claude Desktop, Claude Code,
Codex / ChatGPT, OpenCode, VS Code, or any other AI agent that supports MCP —
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
- **Claude Code** — `claude mcp add --transport http -s user kody <url>`, or a
  `.mcp.json` entry with `"type": "http"`.
- **Codex / ChatGPT** — ChatGPT web uses Developer mode + a connector/app URL.
  Codex (desktop, CLI, IDE) shares `~/.codex/config.toml` with an
  `[mcp_servers.kody]` `url` entry.
- **OpenCode** — Add a `mcp.kody` remote entry in `opencode.json`
  (`"type": "remote"`).
- **VS Code** — Use `.vscode/mcp.json` with root key `servers` (not
  `mcpServers`) and `"type": "http"`.

### Coding vs non-coding agents

Using Kody packages works great with non-coding agents such as Claude Desktop
and ChatGPT. For creating or editing packages, a coding agent (Cursor, Claude
Code, Codex, VS Code, OpenCode, and similar) is usually smoother because those
hosts can edit files and iterate on code more easily.

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
