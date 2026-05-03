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
host verification. The connector never exposes arbitrary router command
execution. It exposes a broader typed read surface (status, WAN/failover,
routing, NAT, VLAN, DNS, users, security policy, QoS, traffic stats, sessions,
VPN, DHCP server, NTP, syslog, SNMP, system info, and bandwidth usage) plus a
set of high-risk, typed, allowlisted write tools. Those write tools require SSH
host verification, explicit risk acknowledgement, and exact confirmation phrases
because mistakes can have severe consequences.

Several of the typed read tools are intentionally derived from the documented
Island CLI families instead of guessed one-off `show` commands:

- WAN, failover, NAT, VLAN, DNS, DHCP server, syslog, and SNMP reads are derived
  from `show running-config`.
- VPN reads are derived from `show vpns`.
- Active-session reads are derived from `show ip sockets`.
- NTP reads are derived from `show ntp status` and `show ntp associations`.
- System-health and bandwidth-style summaries are derived from `show stats` plus
  `show hardware` when available.

If a router command returns Island help, usage, or unknown-command output, the
connector now treats that as unsupported or inconclusive output instead of
trying to parse it as structured data.
