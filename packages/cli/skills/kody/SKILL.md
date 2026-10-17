---
name: kody
description: >
  Install Kody as a remote MCP server, then use `search` / MCP tools and prefer
  `kody execute --local` when the CLI and Node are available. Use when the user
  mentions Kody, kody.codes, durable agent tasks, or wants to search/execute via
  Kody.
---

# Kody

Kody is a remote MCP personal assistant. Install it as an MCP server in this
agent for `search`, `api`, and discovery. Prefer local CLI execute when Node ≥22
and `@kodycodes/cli` are available. Use MCP / hosted paths when the CLI or Node
cannot run.

`@kodycodes/cli` installs host MCP config and runs local execute against real
secrets while keeping `kody:runtime` hops on CapabilityProxy.

## Install the MCP server (recommended)

```bash
npx @kodycodes/cli install
```

That command lists **running local** agents and writes each host's remote MCP
entry for `https://kody.codes/mcp`. Host OAuth stays in that client — do not run
`kody login` for the host connection.

After install, use the Kody MCP tools in this agent for discovery and Open API:

- `search` — discover capabilities, packages, and entity detail
- `api` — call one Open API operation directly (no sandbox)
- Prefer `search` before composing work

For one-off modules, smoke tests, and composition: when Node ≥22 and the CLI are
available, prefer `npx @kodycodes/cli execute --local` (see
[Local CLI execute](https://kody.codes/docs/local-execute)). If `--local` cannot
run, use Open API / MCP `api`, or fix the environment — do **not** use hosted
MCP `execute` for agent work when a local or Open API path exists.

For web-based clients (ChatGPT, Claude.ai, Grok), point the user at
https://kody.codes/onboarding.

To copy this skill into Claude Code / Cursor / Agents:

```bash
npx @kodycodes/cli skill install
```

## CLI

```bash
npm install -g @kodycodes/cli
kody login
kody login --org acme
kody search "what can you do"
kody search --domain email
kody execute --local --code "import { kody } from 'kody:runtime'\nexport default async function main() { return await kody.search({ query: 'what can you do' }) }"
kody execute --local --credential github=work --code "import { credential } from 'kody:runtime'\nexport default async function main() { const gh = await credential('github'); return { name: gh.name, hosts: gh.hosts } }"
kody status
kody whoami
kody logout
```

The CLI opens a browser for Kody OAuth (PKCE + Client ID Metadata Documents). If
a browser cannot open, it prints the URL. Tokens (access + refresh) are stored
in the OS keychain on macOS, Windows, and Linux (Secret Service). Linux without
Secret Service — including headless machines that only have an in-memory kernel
keyring — falls back to a `0600` file under `$XDG_CONFIG_HOME/kody`.

Never ask the user to paste tokens into chat.

Override the MCP URL with `--mcp-url` or `KODY_MCP_URL` for preview or local
servers. Default: `https://kody.codes/mcp`.

To run execute with a scoped API token and **no** `kody login`, set
`KODY_API_TOKEN` (or `--token`). Cloud execute (no `--local`) goes through
CapabilityProxy → `kody.execute`. Add `--local` to run the module on this
machine instead (Node.js 22 or newer; older Node fails before workerd starts).
Modules with static `kody:@…` imports keep `--local`: the CLI fetches stamped
package modules via `POST /v1/local-execute/package-graph` and embeds them in
local workerd (CapabilityProxy only for per-call `kody:runtime` hops — not a
whole-module cloud defer). If that package-graph API is missing, `--local` fails
clearly rather than silently billing a remote execute. `--file` entries are
bundled (relative imports and npm packages; `kody:*` external) before workerd
loads them, matching hosted execute / publish. `--code` and stdin are not
rewritten.

For `execute --local` auth: `--token` / `KODY_API_TOKEN` wins when set;
otherwise a stored token from `kody auth bootstrap --code` (after MCP
`cliCredentialBootstrap`); otherwise a valid `kody login` session (OAuth access
token as Bearer only when the API and MCP URLs are paired — never print it,
never mint via `tokenCreate` under the hood). The default pair is
`https://api.kody.codes` and `https://kody.codes/mcp`; preview workers pair when
the API worker name adds `-api`, and loopback hosts pair at any port. For
another API origin, use `auth bootstrap --api-url <origin>` or set
`KODY_API_TOKEN`. A PR preview's API host is
`https://kody-pr-<n>-api.<subdomain>.workers.dev`, not the app origin
`kody-pr-<n>` (which 404s `/v1/*` with HTML). Prefer bootstrap over
`tokenCreate` for agents already on MCP so `kody_at_…` never appears in chat.
Until the Open API accepts MCP OAuth on CapabilityProxy / package-graph
(https://github.com/kody-hq/kody/issues/2812), use bootstrap or mint a scoped
token with the MCP `api` tool `tokenCreate` — include `local-execute` plus the
capability scopes the module calls — and pass `--token` or `KODY_API_TOKEN`. If
none of those are available, the CLI error says that (bootstrap → login →
tokenCreate for CI). `insufficient_scope` names the missing scope and prints the
exact command to mint a token that adds it:
`npx @kodycodes/cli auth bootstrap --lifetime short|long --scopes <list>` after
`kody login`, or
`cliCredentialBootstrap({ lifetime: "short"|"long", scopes: [...] })` from MCP
(hints preserve the current token's lifetime class when known). Default
bootstrap scopes stay least-privilege (no `package:write`), and `--scopes`
replaces them, so list every scope you need. Publish a package after
`packageGetGitRemote` clone/push with
`kody package publish <@owner/leaf|package_id>` (thin
`packagePublishExternalPush` wrapper; same auth as `kody api`). See and change
who can use a package (teams and org members of the `--org` org) with
`kody package collaborators <package>`,
`kody package grant <package> --team <slug>|--user <username> --preset use|contribute|manage`,
and
`kody package revoke <package> --team <slug>|--user <username>|--grant <id>`.
These need a token with `package:manage_access`. `feature_disabled` means the
account `local-execute` flag is off. Never read MCP OAuth tokens from the host.

```bash
# Agents on MCP:
# cliCredentialBootstrap → { bootstrap_code, cli_command }
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --file ./task.js --params '{"q":"email"}'
# Opt in to private and local network access if needed:
npx @kodycodes/cli execute --local --allow-private-network --file ./task.js

Local execute is public-network-only by default. `--allow-private-network`
opts into private and local addresses; the loopback CapabilityProxy bridge
continues to work either way.

npx @kodycodes/cli login
npx @kodycodes/cli execute --local --file ./task.js --params '{"q":"email"}'
# Or with an explicit scoped token (wins over login / bootstrap store):
KODY_API_TOKEN=… npx @kodycodes/cli execute --local --file ./task.js --params '{"q":"email"}'
```
