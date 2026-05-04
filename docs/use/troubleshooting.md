# Troubleshooting

## Search returns no good matches

- **Rephrase the query** using domain vocabulary from the search tool’s domain
  hints (for example “GitHub”, “Cloudflare”, “meta skills”).
- Try **`meta_list_capabilities`** for the full live registry, including dynamic
  capabilities.
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

## Home automation

If home-related tools appear missing, check connector status with
**`meta_list_remote_connector_status`** (all attached remote connectors) or
**`meta_get_home_connector_status`** (first **`home`** connector only) when
those capabilities are available. For protocol and URL requirements, see
[Remote connectors](../contributing/architecture/remote-connectors.md).

If Island router diagnostics tools are missing or return configuration errors,
verify that the home connector runtime has `ISLAND_ROUTER_HOST`,
`ISLAND_ROUTER_USERNAME`, and `ISLAND_ROUTER_PRIVATE_KEY_PATH` set, and prefer
either `ISLAND_ROUTER_KNOWN_HOSTS_PATH` or `ISLAND_ROUTER_HOST_FINGERPRINT` for
host verification. The connector exposes `router_get_status` and
`router_run_command`. It never accepts arbitrary router CLI text; every command
must be selected from the connector's typed catalog, and every parameter is
validated before rendering.

The command catalog includes read entries such as:

- `show version`, `show clock`, `show hardware`
- `show interface summary`, `show interface`, `show interface transceivers`
- `show ip interface`, `show ip neighbors`, `show ip sockets`
- `show ip dhcp-reservations`, `show ip routes`, `show ip recommendations`
- `show log` and `show syslog` with optional Kody-side filtering/line limiting
- `show running-config`, `show running-config differences`, `show startup-config`
- `show ntp`, `show users`, `show vpns`, `show stats`, and `ping`

Write-risk catalog entries require SSH host verification, a specific operator
reason, and the exact connector confirmation phrase. Commands that change
running config do not automatically run `write memory`; the catalog metadata
states when persistence needs a separate explicit `write memory` command.

If a router command returns Island help, usage, or unknown-command output, the
connector treats that as unsupported or inconclusive output instead of trying to
parse it as structured data.
