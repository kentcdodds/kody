---
id: local_mcp_tunnels
title: Connect local tools through an MCP tunnel
summary:
  Expose an MCP server beside a local vault, CLI, or home device through
  Cloudflare Tunnel and Access, then connect its HTTPS URL to Kody.
category: platform
---

# Connect local tools through an MCP tunnel

Kody runs on Cloudflare Workers, so it cannot connect to a process on your
laptop's `localhost`, read your Obsidian vault directly, or reach a device that
exists only on your home network. Put a small MCP server beside the local
resource, give that server a protected public HTTPS route, and add the route to
Kody as a user MCP server.

The `kody-home-connector` / `mcp:home` pattern has three parts:

1. A local MCP process talks to the vault, installed CLIs, or home devices.
2. Cloudflare Tunnel publishes that process at a stable HTTPS hostname without
   opening an inbound port on the local network.
3. Cloudflare Access and the MCP server's authentication protect the public
   route. Kody connects to the MCP URL, and the tools appear as `mcp:<name>`.

## 1. Keep the MCP server local to the resource

Run the MCP server on a machine that already has legitimate access to the
resource:

- For Obsidian, grant the process access only to the intended vault and expose
  narrow tools such as search, read-note, and create-note.
- For CLIs, wrap explicit commands and validate every argument. Do not expose an
  unrestricted shell tool merely to make a CLI reachable.
- For home devices, put protocol-specific credentials and LAN addresses in the
  local process. Kody calls purpose-built tools rather than joining the home
  network.

Bind the server to a local interface and confirm its MCP endpoint works before
adding a tunnel. Keep authorization checks in the MCP server; the tunnel is
transport, not a replacement for tool-level policy.

## 2. Publish it with Cloudflare Tunnel

Follow Cloudflare's current
[Cloudflare Tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/)
to install `cloudflared`, create a tunnel, and route a hostname to the local MCP
process. The public result is an HTTPS MCP URL such as
`https://home.example.com/mcp`; the origin remains on the private network.

Use Cloudflare's guide for the dashboard or CLI details rather than copying
provider steps into this guide. Cloudflare owns those screens and commands. Keep
the connector running under the local machine's normal service manager so the
URL does not depend on an open terminal.

## 3. Put Access in front of the human authorization route

Create a self-hosted Access application by following Cloudflare's
[Access guide for self-hosted applications](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).
Require the identity and policy appropriate for the people allowed to authorize
this connector. Give each Kody account its own MCP connection, credential, and
authorization state. Do not reuse one connector bearer across Kody accounts. If
several accounts share a public endpoint, the MCP server must isolate tenants
and bind every authenticated request to exactly one Kody user's local resources.

An OAuth-capable MCP server has both machine-to-machine protocol routes and a
human authorization route. Match Access path policies to the routes your MCP
implementation documents:

- Allow only the MCP endpoint and the OAuth discovery, registration (when the
  server advertises it), token, refresh, and revocation routes documented by the
  server to bypass Access so Kody can complete the protocol.
- Require Cloudflare Access on the human authorization route. The person signs
  in to Access before approving Kody.
- Keep the MCP server's OAuth checks enabled on every MCP request. An Access
  bypass for a protocol route makes Access skip that route; it does not make the
  route public when the MCP server still requires its own token.

This is the `kody-home-connector` shape: the local origin trusts its own network
context, the MCP server authenticates Kody, and Access protects the browser
approval step. Do not copy route names from another server without checking your
implementation's OAuth metadata and endpoint paths.

The reference `mcp:home` connector uses `https://home.example.com/mcp` as its
resource server. Its protected resource metadata lives at
`/.well-known/oauth-protected-resource/mcp` and identifies
`https://home.example.com` as the authorization server. That server's
`/.well-known/oauth-authorization-server` document advertises `/authorize`,
`/token`, and `/revoke`. Access protects the browser-facing `/authorize` route;
the metadata routes, `/mcp`, `/token`, and `/revoke` reach the MCP server, which
still requires and validates its own OAuth credentials. Treat those paths as a
worked example, not defaults: read both metadata documents on your own hostname
and build the Access path policies from what they advertise.

If the server uses a static bearer token instead of OAuth, verify that the
Access policy and the client can exchange the credentials that policy expects.
Kody's user MCP connection supports one stored `Authorization` value; it does
not supply Cloudflare Access service-token header pairs. Prefer the OAuth shape
above when Access protects a browser authorization flow.

## 4. Connect the public MCP URL to Kody

Follow [Connect remote MCP servers to Kody](../use/mcp-client-servers.md):

1. Open `/account/mcp-servers`, or ask the agent to call `mcp_server_add`.
2. Choose a short kebab-case name such as `obsidian` or `home` and enter the
   public HTTPS MCP URL. Create a separate connection and credential for each
   Kody account.
3. Open the returned authorization link, pass Cloudflare Access, and approve the
   MCP server's OAuth request. For a compatible static bearer server, provide
   its bearer credential when adding the connection.
4. Confirm the connection with `mcp_server_list`, then search the synthesized
   domain such as `mcp:obsidian` or `mcp:home`.
5. Invoke a read-only tool first and confirm the request reaches the expected
   local resource.

The local process must stay online for its tools to work. Kody-hosted packages,
jobs, and memories remain available when your computer is offline, but a job
that calls a tunneled local MCP tool still depends on that connector and its
network.

## Security checklist

- Expose an MCP endpoint, not a general-purpose shell or filesystem server.
- Restrict the local process to the smallest vault, command set, or device set.
- Never share connector credentials between Kody accounts. On a shared endpoint,
  enforce tenant isolation for credentials, authorization state, and every
  local-resource lookup.
- Keep MCP authentication enabled even where Access allows protocol traffic.
- Review Access logs, MCP server logs, and Kody activity after a smoke test.
- Rotate the MCP credential and tunnel credentials if the connector machine is
  lost or rebuilt.
- Remove the Kody MCP connection and disable the tunnel when the local
  capability is retired.
