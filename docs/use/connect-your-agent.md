# Connect your agent

Kody is an MCP server. You use it from Cursor, ChatGPT, Codex, Claude Desktop,
Grok.com, Grok CLI, Grok Bot, Claude Code, OpenCode, OpenClaw, Devin, Gemini,
GitHub Copilot (VS Code or CLI), the GitHub Copilot app, or any other AI agent
that supports MCP — not from a separate Kody chat app.

Agents discovering this host can read `/auth.md` for the OAuth registration
block and MCP URL, and `/.well-known/mcp/server-card.json` for the server card.
People following a host-specific walkthrough can stay on this page or use Get
started (`/onboarding`).

The in-app Get started page (`/onboarding`) asks which agent you want to connect
first, then shows only that host's install steps. A second client is worth it
later when you want the same [memories](./memory.md) and packages from another
agent — you do not need every host on day one.

## Add the MCP server

1. Open Get started (`/onboarding`).
2. Choose the agent you want to connect.
3. Follow that host's steps (plugin, vendor CLI, or the MCP URL). Preview and
   local origins use that deployment's MCP URL (`https://<this-host>/mcp`). On
   [kody.codes](https://kody.codes) the MCP URL is `https://kody.codes/mcp`.
4. Complete the OAuth flow when the host opens it. Sign in to Kody if needed,
   then approve access. Approving gives that agent full access to this Kody
   account — not a limited permission set.

Your account email must be verified before authorize can finish or MCP can run.
If authorize asks you to verify, keep that tab open, finish verification (from
the email link or `/pending-verification`), then continue. You do not need to
restart the host connection. Unverified visits to Get started (`/onboarding`)
redirect to `/pending-verification`; after verification, onboarding shows the
MCP URL and setup prompt.

### Client notes

Get started shows one host at a time after you pick it. Use **Not listed** when
your agent is not in the featured chooser (More hosts are listed there), or when
you only have the MCP URL.

- **Cursor** — Install the official
  [Kody plugin](https://cursor.com/marketplace/kody), or in Cursor chat run
  `/add-plugin kody`. After install, Authenticate in the Cursor MCP list.
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
- **Grok Bot** — Grok Bot is Cursor's desktop assistant, not grok.com. Add the
  official Kody plugin with
  [`grokbot://app/v1/plugin/add?id=56286216`](grokbot://app/v1/plugin/add?id=56286216),
  or open **Plugins** in the Grok Bot sidebar and add Kody. See Cursor's
  [Grok Bot plugin help](https://cursor.com/help/grok-bot/connect-plugins).
- **Claude Code** — After the CLI writes the remote entry, enter `/mcp` → Kody →
  Authenticate. Manual includes
  `claude mcp add --transport http -s user kody <url>`, or a `.mcp.json` entry
  with `"type": "http"`.
- **ChatGPT.com** — This is the web app. On an
  [eligible paid plan (Plus, Pro, Business, Enterprise, or Education)](https://developers.openai.com/api/docs/guides/developer-mode),
  turn on Developer mode (Settings → Security and login), then create an app
  under Settings → Plugins → Browse plugins → Create app with the MCP URL. In a
  managed workspace, ask an admin to enable access if the setting or Plugins UI
  is missing. Use the connector icon (`/images/kody-app-icon.png`, 256×256 and
  under ChatGPT's 10 KB limit) — right-click Save as on the connect page, then
  upload it. The owner can edit a developer-mode app's name and logo later from
  Manage in Apps settings. ChatGPT desktop is Codex — use that entry instead.
- **Codex** — ChatGPT desktop is Codex. After the CLI writes the shared config,
  run `codex mcp login kody` if OAuth does not start. Manual includes
  `codex mcp add kody --url <url>` and the shared `~/.codex/config.toml`
  `[mcp_servers.kody]` `url` entry. If Codex asks you to log in again after
  about an hour, see
  [Codex keeps asking for `codex mcp login kody`](./troubleshooting.md#codex-keeps-asking-for-codex-mcp-login-kody).
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
- **Devin** — In Devin Desktop, add a custom remote MCP server and paste the MCP
  URL. Complete OAuth when Devin opens it. The same connector works from the
  mobile-friendly web app.
- **Gemini** — In the Gemini app or Jules, add a custom MCP connector and paste
  the MCP URL. Complete OAuth when Google prompts you.
- **OpenClaw** — Run
  `openclaw mcp add kody --url <url> --transport streamable-http --auth oauth`,
  then `openclaw mcp login kody`. `openclaw mcp doctor kody --probe` checks the
  live connection. Or in the Control UI: Settings → MCP → Add server, choose
  Streamable HTTP, and paste the MCP URL. See OpenClaw's
  [MCP docs](https://docs.openclaw.ai/tools/mcp).
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
ChatGPT.com, Grok.com, Grok Bot, Gemini, and the GitHub Copilot app. For
creating or editing packages, a coding agent (Cursor, Claude Code, Codex /
ChatGPT desktop, Grok CLI, Copilot, OpenCode, Devin, Pi, OpenClaw, and similar)
is usually smoother because those hosts can edit files and iterate on code more
easily.

## Give Kody Access, then persist a first build

After the connection works, Get started Step 2 is **Give Kody Access**: official
one-click login for Notion, Linear, Atlassian, Stripe, Sentry, and Canva.
Connect authorizes the service and copies the matching official helper into your
account. You run that owned copy — official `@kody/*` listings are a catalog,
not something a person account invokes live. You can also add a custom server,
follow an Advanced provider guide ([GitHub](/guides/github),
[Google](/guides/google)), try a zero-auth example, or skip.

Step 3 copies a prompt that asks your agent to run one ad hoc request, then
persist that working code as a package you own. If nothing fits, use **Choose
your own adventure** to copy an open-ended setup prompt.

## Where to go next

- [First steps](./first-steps.md) — search-first habits and common goals
- [Troubleshooting](./troubleshooting.md) — auth, empty results, and approvals
