# Troubleshooting

## Contact support

For help with the hosted Kody service at `kody.codes`, email
[`support@kody.codes`](mailto:support@kody.codes). Operators of other Kody
deployments receive support mail at `support@<apex>`, where `<apex>` is the
deployment's `APP_BASE_URL` hostname.

## MCP requests fail with `email_verification_required`

Kody requires a verified account email before any MCP access, including OAuth
authorization. Open the verification link sent at signup, or sign in and use
**Resend verification email** on `/pending-verification`, `/account`, or the
authorize page. Keep an open `/oauth/authorize` tab so you can continue the same
OAuth request after verifying in another tab, then reconnect or approve again.

## The host never opens the Kody authorize window

Dynamic OAuth needs the host to open `/oauth/authorize`. If Admin add-connection
succeeds but enabling the MCP tool in chat never opens that window, retry from
another browser or device. That is a host or environment issue, not a failed
Kody registration. In Open WebUI, do not set an OAuth MCP tool as a model
default or pre-enabled tool — enable it in the chat so the host can open the
authorize window. Hosts that require a pre-registered Client ID and Client
Secret can mint one at Account → Advanced → MCP OAuth clients and use the host’s
static OAuth mode. Static mode runs authorize and token exchange.

## Adding a remote MCP server fails with `Invalid origin uri` or redirect URI errors

That message comes from the **remote** authorization server, not from Kody being
unreachable. Kody identifies as an OAuth client from the deployment origin and
redirects to `{origin}/account/mcp-servers/oauth/callback`. Allow those values
in the MCP server's identity provider (authorized origins / redirect URIs). When
the authorization server advertises `client_id_metadata_document_supported` and
the callback origin is HTTPS, Kody also presents
`{origin}/oauth/client-metadata.json` as its CIMD `client_id` — allowlist that
URL only for CIMD-capable providers. Then remove and re-add the server. See
[Connect remote MCP servers](./mcp-client-servers.md). For a home process behind
Cloudflare Tunnel and Access, also see
[Connect a home MCP server](../guides/local-mcp-tunnels.md) and
[home-mcp-starter](https://github.com/kody-bot/home-mcp-starter).

## Search returns no good matches

- **Rephrase the query** using domain vocabulary from the search tool’s domain
  hints (for example “GitHub”, “Cloudflare”, “meta capabilities”).
- Try **`meta_list_capabilities`** for the full live registry, including dynamic
  entries from MCP servers.
- **`entity: "id:capability"`** looks up a **known** id. It does **not** turn an
  empty ranked **`query`** into better matches — rephrase or list capabilities
  instead.

## Saved packages missing

Saved packages require an **authenticated MCP user**. If the client is not
signed in, user-scoped package results are empty.

## Fetch or secret errors

- **Host not approved:** complete the approval flow in the app for that secret
  and host.
- **Capability not allowed for secret:** adjust the secret’s allowed-capability
  policy or use a capability that is on the allowlist.

## MCP servers

If tools from a connected MCP server appear missing, open
[`/account/mcp-servers`](./mcp-client-servers.md) (or ask `mcp_server_list`) and
confirm the server is connected and authorized. Home automation is a normal
outbound MCP server (`kody.mcp["home"]`). See
[Connect remote MCP servers](./mcp-client-servers.md).

## Job, webhook, or package app failed

Open **[`/account/activity`](./activity.md)** (failures-first) or ask your agent
to use **`run_summary`** / **`run_list`** / **`run_get`**. Successful key-less
ad-hoc **`execute`** calls are not stored there — only execute failures, keyed
execute runs (including successes), and other runtime surfaces.
