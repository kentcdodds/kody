---
id: local_mcp_tunnels
title: Connect a home MCP server
summary:
  Run an MCP server beside a vault, CLI, or home device, publish it with
  Cloudflare Tunnel and Access, and connect its HTTPS URL to Kody.
category: platform
image: /images/kody-home-nas.webp
imageAlt: Kody in a living room with his hand on a logo-free home NAS
ogImage: /images/kody-home-nas-og.jpg
---

# Connect a home MCP server

Kody runs on Cloudflare Workers. It cannot open `localhost` on your laptop, read
a vault on disk, or talk to a device that exists only on your home network. Put
a small MCP server beside that resource, give the server a protected public
HTTPS URL, and add the URL as a user MCP server. The tools then appear under
`mcp:<name>`.

The [home-mcp-starter](https://github.com/kody-bot/home-mcp-starter) repository
is a complete, forkable implementation: Streamable HTTP MCP, CIMD-only OAuth,
Docker, Cloudflare Tunnel and Access docs, and example household-notes tools you
replace with your own LAN surface.

## Use cases

A home MCP server is the right shape when the capability has to live next to
something Kody cannot reach:

- **Notes and vaults.** Search and write a local notes file or an Obsidian vault
  on the same machine. Keep the tools narrow (search, read, create) instead of
  exposing the whole filesystem.
- **Home devices.** Lights, TVs, thermostats, shades, and similar LAN APIs stay
  on the home process. Kody calls purpose-built tools; it never joins the home
  network.
- **Local CLIs.** Wrap explicit commands and validate every argument. Do not
  expose an unrestricted shell merely to make a CLI reachable.
- **NAS-hosted automations.** Run the server in Docker on an always-on box so
  scheduled Kody jobs can call home tools while your laptop is asleep.

Kody-hosted packages, jobs, and memories stay available when the home machine is
offline. A job that calls a tunneled home tool still depends on that process and
its network.

## The pattern

Three parts:

1. A local MCP process talks to the vault, CLI, or devices.
2. Cloudflare Tunnel publishes that process at a stable HTTPS hostname without
   opening an inbound port.
3. Cloudflare Access and the MCP server's own OAuth protect the public route.
   Kody connects to the MCP URL.

The starter implements this with MCP protocol `2026-07-28` over Streamable HTTP
at `/mcp`. Authorization is Client ID Metadata Documents (CIMD) only: there is
no Dynamic Client Registration. Production Kody presents
`https://kody.codes/oauth/client-metadata.json` as `client_id` and callbacks at
`/account/mcp-servers/oauth/callback`.

## 1. Run the server next to the resource

Start from the starter (Node 24 or Docker):

```bash
git clone https://github.com/kody-bot/home-mcp-starter.git
cd home-mcp-starter
cp .env.example .env
npm install
npm run dev
```

Or run the published image. See the starter's
[Docker guide](https://github.com/kody-bot/home-mcp-starter/blob/main/docs/docker.md).

Bind the process to a local interface and confirm `/health` and the MCP endpoint
before adding a tunnel. Keep authorization checks in the MCP server; the tunnel
is transport, not a replacement for tool-level policy.

Replace the example notes tools with adapters for your vault, devices, or CLIs.
The starter's
[adding-tools guide](https://github.com/kody-bot/home-mcp-starter/blob/main/docs/adding-tools.md)
covers schemas, destructive hints, and why unrestricted shells do not belong
here.

## 2. Publish it with Cloudflare Tunnel

Follow Cloudflare's current
[Tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/)
to install `cloudflared`, create a tunnel, and route a hostname to the local
process (typically `http://127.0.0.1:4040`). The public result is an HTTPS MCP
URL such as `https://home.example.com/mcp`; the origin stays on the private
network.

Set `HOME_MCP_PUBLIC_BASE_URL` to that HTTPS origin (no trailing slash). OAuth
issuer, authorize/token URLs, and the RFC 8707 `resource` value all derive from
it. They must match the URL you later paste into Kody.

Use Cloudflare's guide for dashboard or CLI details. Keep the connector running
under the machine's service manager so the URL does not depend on an open
terminal. The starter's
[Tunnel guide](https://github.com/kody-bot/home-mcp-starter/blob/main/docs/cloudflare-tunnel.md)
records the Home MCP-specific env and routing notes.

## 3. Put Access in front of the human authorize route

Create a self-hosted Access application by following Cloudflare's
[Access guide for self-hosted applications](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).
Require the identity and policy appropriate for the people allowed to authorize
this server.

An OAuth-capable MCP server has machine protocol routes and a human
authorization route. Match Access path policies to the routes the starter
documents:

- **Bypass** `/mcp`, `/token`, `/revoke`, `/.well-known`, and `/health` so Kody
  can complete CIMD OAuth and call tools.
- **Allow** `/authorize` and `/` so a person signs in to Access before approving
  Kody.
- Keep the MCP server's OAuth checks enabled on every `/mcp` request. An Access
  bypass skips Access; it does not make the route public when the server still
  requires a bearer.

The local origin trusts its own network. Access protects the browser approve
step. The MCP server authenticates Kody. Read the starter's well-known documents
on your hostname and build policies from what they advertise. Full path notes
live in the starter's
[Access guide](https://github.com/kody-bot/home-mcp-starter/blob/main/docs/cloudflare-access.md).

Give each Kody account its own MCP connection and authorization grant. Do not
reuse one bearer across accounts. If several accounts share a public endpoint,
the MCP server must isolate tenants and bind every authenticated request to
exactly one user's local resources.

Kody's user MCP connection supports one stored `Authorization` value. It does
not supply Cloudflare Access service-token header pairs. Prefer the OAuth shape
above when Access protects a browser authorization flow.

## 4. Connect the public MCP URL to Kody

Follow [Connect remote MCP servers to Kody](../use/mcp-client-servers.md):

1. Open `/account/mcp-servers`, or ask the agent to call `mcp_server_add`.
2. Choose a short kebab-case name such as `home` or `obsidian` and enter the
   public HTTPS MCP URL. Create a separate connection for each Kody account.
3. Open the returned authorization link, pass Cloudflare Access, and approve the
   MCP server's OAuth request.
4. Confirm with `mcp_server_list`, then search the synthesized domain such as
   `mcp:home`.
5. Invoke a read-only tool first (`home_get_metadata` on the starter) and
   confirm the request reaches the expected local resource.

On HTTPS Kody, the client identifies itself with CIMD. Allowlist:

- **Client origin:** `https://kody.codes`
- **Redirect URI:** `https://kody.codes/account/mcp-servers/oauth/callback`
- **CIMD `client_id`:** `https://kody.codes/oauth/client-metadata.json`

Self-hosted Kody uses that deployment's origin in all three places. Details are
in [Connect remote MCP servers](../use/mcp-client-servers.md) and the starter's
[OAuth and CIMD](https://github.com/kody-bot/home-mcp-starter/blob/main/docs/oauth-cimd.md)
page.

## Security checklist

- Expose an MCP endpoint, not a general-purpose shell or filesystem server.
- Restrict the local process to the smallest vault, command set, or device set.
- Never share connector credentials between Kody accounts. On a shared endpoint,
  enforce tenant isolation for credentials, authorization state, and every
  local-resource lookup.
- Keep MCP authentication enabled even where Access allows protocol traffic.
- Review Access logs, MCP server logs, and Kody activity after a smoke test.
- Rotate MCP grants and tunnel credentials if the connector machine is lost or
  rebuilt.
- Remove the Kody MCP connection and disable the tunnel when the local
  capability is retired.
